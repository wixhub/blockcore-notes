import { Event, Filter, kinds, Relay } from 'nostr-tools';
import { NostrRelay, NostrRelaySubscription, NostrSubscription, QueryJob } from '../services/interfaces';
import { RelayResponse } from '../services/messages';
import { Queue } from '../services/queue';
import { LoggerService } from '../services/logger';
import { inject } from '@angular/core';

export class RelayWorker {
  relay!: NostrRelay;

  /** These are the subscription instances connected to the relay. */
  // subs: NostrSub[] = [];
  /** These are the subscriptions the app has requested and manages. */
  subscriptions: NostrRelaySubscription[] = [];

  queue: Queue;

  // logger = console;
  // Enable this to hide all logging from the relay.
  logger = {
    log: (message?: any, ...optionalParams: any) => {},
    info: (message?: any, ...optionalParams: any) => {},
    warn: (message?: any, ...optionalParams: any) => {},
    error: (message?: any, ...optionalParams: any) => {},
    debug: (message?: any, ...optionalParams: any) => {}
  };

  constructor(public url: string) {
    this.queue = new Queue();
  }

  async publish(event: Event) {
    if (event.kind == kinds.LongFormArticle || (event.kind as number) == 30008 || (event.kind as number) == 30009) {
      // If we don't have metadata from the relay, don't publish articles.
      if (!this.relay.nip11) {
        this.logger.info(`${this.relay.url}: This relay does not return NIP-11 metadata. Article/Badge will not be published here.`);
        return;
      } else if (!this.relay.nip11.supported_nips.includes(33)) {
        this.logger.info(`${this.relay.url}: This relay does not support NIP-23. Article/Badge will not be published here.`);
        return;
      } else {
        this.logger.info(`${this.relay.url}: This relay supports NIP-23. Publishing article/badge on this relay.`);
      }
    }

    try {
      let pub = await this.relay.publish(event);
      this.logger.info(`we saw the event on ${this.relay.url}`);
    } catch (err) {
      this.logger.error(`failed to publish to ${this.relay.url}: ${err}`);
      postMessage({ type: 'failure', data: err, url: this.relay.url } as RelayResponse);
    }

    // pub.on('ok', () => {
    //   this.logger.info(`${this.relay.url} has accepted our event`);
    // });
    // pub.on('seen', () => {
    //   this.logger.info(`we saw the event on ${this.relay.url}`);
    // });
    // pub.on('failed', (reason: any) => {
    //   this.logger.info(`failed to publish to ${this.relay.url}: ${reason}`);
    //   postMessage({ type: 'failure', data: reason, url: this.relay.url } as RelayResponse);
    // });
  }

  /** Enques a job to be processed against connected relays. */
  enque(job: QueryJob) {
    // It is way more optimal to just delegate jobs into separate queues when enquing than querying later.
    if (job.type == 'Profile') {
      this.queue.queues.profile.jobs.push(job);
    } else if (job.type == 'Contacts') {
      this.queue.queues.contacts.jobs.push(job);
    } else if (job.type == 'Event') {
      this.queue.queues.event.jobs.push(job);
    } else if (job.type == 'Article') {
      this.queue.queues.article.jobs.push(job);
    } else if (job.type == 'BadgeDefinition') {
      this.queue.queues.badgedefinition.jobs.push(job);
    } else {
      throw Error(`This type of job (${job.type}) is currently not supported.`);
    }

    this.logger.info(`${this.url}: Job enqueued...processing...`);

    // We always delay the processing in case we receive more.
    setTimeout(() => {
      this.process();
    }, 500);
  }

  process() {
    this.processArticle();
    this.processBadgeDefinition();
    this.processProfiles();
    this.processContacts();
    this.processEvents();
    this.processSubscriptions();
  }

  processSubscriptions() {
    if (!this.relay || !this.relay.connected) {
      return;
    }

    if (this.queue.queues.subscriptions.jobs.length == 0) {
      return;
    }

    while (this.queue.queues.subscriptions.jobs.length) {
      const job = this.queue.queues.subscriptions.jobs.shift();

      if (job) {
        this.subscribe(job.filters, job.id);
      }
    }
  }

  processProfiles() {
    if (!this.relay || !this.relay.connected || this.queue.queues.profile.active) {
      this.logger.info(`${this.url}: processProfiles: Relay not ready or currently active: ${this.queue.queues.profile.active}.`, this.relay);
      return;
    }

    if (this.queue.queues.profile.jobs.length == 0) {
      this.queue.queues.profile.active = false;
      return;
    }

    this.queue.queues.profile.active = true;

    const profilesToDownload = this.queue.queues.profile.jobs
      .splice(0, 500)
      .map((j) => j.identifier)
      .filter((v, i, a) => a.indexOf(v) === i); // Unique, it can happen that multiple of same is added.

    this.downloadProfile(profilesToDownload, profilesToDownload.length * 3);
  }

  processContacts() {
    if (!this.relay || !this.relay.connected || this.queue.queues.contacts.active) {
      return;
    }

    if (this.queue.queues.contacts.jobs.length == 0) {
      this.queue.queues.contacts.active = false;
      return;
    }

    this.queue.queues.contacts.active = true;
    const job = this.queue.queues.contacts.jobs.shift();

    this.downloadContacts(job!.identifier, () => {
      this.queue.queues.contacts.active = false;
      this.processContacts();
    });
  }

  processEvents() {
    if (!this.relay || !this.relay.connected || this.queue.queues.event.active) {
      this.logger.info(`${this.url}: processEvents: Relay not ready or currently active: ${this.queue.queues.event.active}.`, this.relay);
      return;
    }

    this.logger.info(`${this.url}: processEvents: Processing with downloading... Count: ` + this.queue.queues.event.jobs.length);

    if (this.queue.queues.event.jobs.length == 0) {
      this.queue.queues.event.active = false;
      return;
    }

    this.queue.queues.event.active = true;

    this.logger.info(this.relay);

    const eventsToDownload = this.queue.queues.event.jobs
      .splice(0, 500)
      .map((j) => j.identifier)
      .filter((v, i, a) => a.indexOf(v) === i); // Unique, it can happen that multiple of same is added.

    this.logger.info('eventsToDownload:', eventsToDownload);
    this.downloadEvent(eventsToDownload, eventsToDownload.length * 3);
  }

  processArticle() {
    if (!this.relay || !this.relay.connected || this.queue.queues.article.active) {
      
      this.logger.info(`${this.url}: processArticle: Relay not ready or currently active: ${this.queue.queues.article.active}.`, this.relay);
      return;
    }

    this.logger.info(`${this.url}: processArticle: Processing with downloading... Count: ` + this.queue.queues.article.jobs.length);

    if (this.queue.queues.article.jobs.length == 0) {
      this.queue.queues.article.active = false;
      return;
    }

    this.queue.queues.article.active = true;

    this.logger.info(this.relay);

    const eventsToDownload = this.queue.queues.article.jobs
      .splice(0, 500)
      .map((j) => j.identifier)
      .filter((v, i, a) => a.indexOf(v) === i); // Unique, it can happen that multiple of same is added.

    this.logger.info('articleToDownload:', eventsToDownload);
    this.downloadArticle(eventsToDownload, eventsToDownload.length * 3);
  }

  processBadgeDefinition() {
    if (!this.relay || !this.relay.connected || this.queue.queues.badgedefinition.active) {
      this.logger.info(`${this.url}: processBadgeDefinition: Relay not ready or currently active: ${this.queue.queues.badgedefinition.active}.`, this.relay);
      return;
    }

    this.logger.info(`${this.url}: processBadgeDefinition: Processing with downloading... Count: ` + this.queue.queues.badgedefinition.jobs.length);

    if (this.queue.queues.badgedefinition.jobs.length == 0) {
      this.queue.queues.badgedefinition.active = false;
      return;
    }

    this.queue.queues.badgedefinition.active = true;

    this.logger.info(this.relay);

    const eventsToDownload = this.queue.queues.badgedefinition.jobs
      .splice(0, 500)
      .map((j) => j.identifier)
      .filter((v, i, a) => a.indexOf(v) === i); // Unique, it can happen that multiple of same is added.

    this.logger.info('badgeDefinitionsToDownload:', eventsToDownload);
    this.downloadBadgeDefinition(eventsToDownload, eventsToDownload.length * 3);
  }

  /** Provide event to publish and terminate immediately. */
  async connect(event?: any) {
    // const relay = relayInit('wss://relay.nostr.info');
    try {
    const relay = await Relay.connect(this.url) as NostrRelay;
    // relay.subscriptions = [];
    this.relay = relay;

    // If the async connect call works, we are connected.
    this.logger.info(`${this.url}: Connected.`);
    postMessage({ type: 'status', data: 1, url: relay.url } as RelayResponse);

    // If there was an event provided, publish it and then disconnect.
    if (event) {
      await this.publish(event);
      this.disconnect();
      postMessage({ type: 'terminated', url: this.url } as RelayResponse);
    } else {
      // Make sure we set the relay as well before processing.
      // this.relay = relay;

      // Upon connection, make sure we process anything that is in the queue immediately:
      this.process();
      // onConnected(relay);
      //this.onConnected(relay);
  }

  this.relay.onclose = () => {
    this.logger.info(`${this.url}: DISCONNECTED!`);
    this.subscriptions = [];
    postMessage({ type: 'status', data: 0, url: relay.url } as RelayResponse);
  }

  this.relay.onnotice = (msg: any) => {
    this.logger.info(`${this.url}: NOTICE: ${msg}`);
    postMessage({ type: 'notice', data: msg, url: relay.url } as RelayResponse);
  }

    // relay.on('connect', async () => {
      
    // });

    // relay.on('disconnect', () => {

    // });

    // relay.on('notice', (msg: any) => {
    //   this.logger.info(`${this.url}: NOTICE: ${msg}`);
    //   postMessage({ type: 'notice', data: msg, url: relay.url } as RelayResponse);
    // });

  
      // await relay.connect();
    } catch (err) {
      postMessage({ type: 'error', relay: this.url, error: 'Unable to connect.' });
      console.error('Unable to connect.');
    }
  }

  disconnect() {
    if (this.relay.connected) {
      this.logger.info(`${this.url}: relay.status: ${this.relay.connected}, calling close!`);
      this.relay.close();
    }
  }

  unsubscribe(id: string) {
    const index = this.subscriptions.findIndex((s) => s.id === id);

    if (index == -1) {
      return;
    }

    const sub = this.subscriptions[index];
    this.subscriptions.splice(index, 1);

    // Unsub from the relay.
    sub.sub?.close();
    this.logger.info('Unsubscribed: ', id);
  }

  // subscribeAll(subscriptions: NostrRelaySubscription[]) {
  //   debugger;

  //   if (!subscriptions) {
  //     return;
  //   }

  //   for (let index = 0; index < subscriptions.length; index++) {
  //     const sub = subscriptions[index];
  //     this.subscribe(sub.filters, sub.id);
  //   }
  // }

  profileSub?: NostrSubscription;
  profileTimer?: any;

  contactsSub?: NostrSubscription;
  contactsTimer?: any;

  eventSub?: NostrSubscription;
  eventTimer?: any;

  articleSub?: NostrSubscription;
  articleTimer?: any;

  badgeDefinitionSub?: NostrSubscription;
  badgeDefinitionTimer?: any;

  clearProfileSub() {
    this.profileSub?.close();
    this.profileSub = undefined;
  }

  clearContactsSub() {
    this.contactsSub?.close();
    this.contactsSub = undefined;
  }

  clearEventSub() {
    this.eventSub?.close();
    this.eventSub = undefined;
  }

  clearArticleSub() {
    this.articleSub?.close();
    this.articleTimer = undefined;
  }

  clearBadgeDefinitionSub() {
    this.badgeDefinitionSub?.close();
    this.badgeDefinitionTimer = undefined;
  }

  downloadProfile(pubkeys: string[], timeoutSeconds: number = 12) {
    this.logger.info('DOWNLOAD PROFILE....');
    let finalizedCalled = false;

    if (!this.relay) {
      debugger;
      this.logger.warn('This relay does not have active connection and download cannot be executed at this time.');
      return;
    }

    // If the profilesub already exists, unsub and remove.
    if (this.profileSub) {
      this.logger.info('Profile sub already existed, unsub before continue.');
      this.clearProfileSub();
    }

    // Skip if the subscription is already added.
    // if (this.subscriptions.findIndex((s) => s.id == id) > -1) {
    //   debugger;
    //   this.logger.info('This subscription is already added!');
    //   return;
    // }

    const url = this.url;

    const sub = this.relay.subscribe([{ kinds: [0], authors: pubkeys }], {

      onevent: (event: Event) => {
        this.logger.info('POST MESSAGE BACK TO MAIN');
        postMessage({ url: url, type: 'event', data: event } as RelayResponse);
        this.logger.info('FINISHED POST MESSAGE BACK TO MAIN');
        // this.logger.info('CLEAR PROFILE SUBSCRIPTION....');
      },

    oneose: () => {
      this.logger.info('eose on profile, profile likely not found.');
      clearTimeout(this.profileTimer);
      this.clearProfileSub();
      this.queue.queues.profile.active = false;
      this.processProfiles();
    }
      



    }) as NostrSubscription;
    this.profileSub = sub;
    // sub.id = id;
    // this.logger.info('SUBSCRIPTION:', sub);
    // this.subscriptions.push({ id: id, filters: filters, sub: sub });

    // const sub = relay.sub(filters, {}) as NostrSubscription;
    // relay.subscriptions.push(sub);

    // sub.on('event', (originalEvent: any) => {
    //   this.logger.info('POST MESSAGE BACK TO MAIN');
    //   postMessage({ url: this.url, type: 'event', data: originalEvent } as RelayResponse);
    //   this.logger.info('FINISHED POST MESSAGE BACK TO MAIN');
    //   // this.logger.info('CLEAR PROFILE SUBSCRIPTION....');

    //   // this.clearProfileSub();
    //   // clearTimeout(this.profileTimer);
    //   // this.logger.info('FINISHED CLEAR PROFILE SUBSCRIPTION....');

    //   // this.queue.queues.profile.active = false;
    //   // this.processProfiles();

    //   // if (!finalizedCalled) {
    //   //   finalizedCalled = true;
    //   //   this.logger.info('Calling finalized!!!');
    //   //   finalized();
    //   //   this.logger.info('Called finalized!!!');
    //   // }

    //   // this.logger.info('Profile event received, finalized called.');

    //   // const event = this.eventService.processEvent(originalEvent);
    //   // if (!event) {
    //   //   return;
    //   // }
    //   // observer.next(event);
    // });

    // sub.on('eose', () => {
    //   this.logger.info('eose on profile, profile likely not found.');
    //   clearTimeout(this.profileTimer);
    //   this.clearProfileSub();
    //   this.queue.queues.profile.active = false;
    //   this.processProfiles();
    // });

    this.logger.info('REGISTER TIMEOUT!!', timeoutSeconds * 1000);

    this.profileTimer = setTimeout(() => {
      this.logger.warn(`${this.url}: Profile download timeout reached.`);
      this.clearProfileSub();
      this.queue.queues.profile.active = false;
      this.processProfiles();

      postMessage({ url: this.url, type: 'timeout', data: { type: 'Profile', identifier: pubkeys } } as RelayResponse);

      // if (!finalizedCalled) {
      //   finalizedCalled = true;
      //   finalized();
      // }
    }, timeoutSeconds * 1000);
  }

  downloadContacts(pubkey: string, finalized: any, timeoutSeconds: number = 3000) {
    this.logger.info('DOWNLOAD CONTACTS....');
    let finalizedCalled = false;

    if (!this.relay) {
      this.logger.warn('This relay does not have active connection and download cannot be executed at this time.');
      return;
    }

    // If the profilesub already exists, unsub and remove.
    if (this.contactsSub) {
      this.clearContactsSub();
    }

    const sub = this.relay.subscribe([{ kinds: [3], authors: [pubkey] }], {

      onevent: (event: Event) => {

        postMessage({ url: this.url, type: 'event', data: event } as RelayResponse);
        this.clearContactsSub();
        clearTimeout(this.contactsTimer);
        if (!finalizedCalled) {
          finalizedCalled = true;
          finalized();
        }
      }



    }) as NostrSubscription;
    this.contactsSub = sub;

    // sub.on('event', (originalEvent: any) => {
    //   postMessage({ url: this.url, type: 'event', data: originalEvent } as RelayResponse);
    //   this.clearContactsSub();
    //   clearTimeout(this.contactsTimer);
    //   if (!finalizedCalled) {
    //     finalizedCalled = true;
    //     finalized();
    //   }
    // });

    this.contactsTimer = setTimeout(() => {
      this.clearContactsSub();
      if (!finalizedCalled) {
        finalizedCalled = true;
        finalized();
      }
    }, timeoutSeconds * 1000);
  }

  downloadArticle(ids: string[], timeoutSeconds: number = 12) {
    this.logger.info('DOWNLOAD ARTICLE....');
    let finalizedCalled = false;

    if (!this.relay) {
      debugger;
      this.logger.warn('This relay does not have active connection and download cannot be executed at this time.');
      return;
    }

    // If the profilesub already exists, unsub and remove.
    if (this.articleSub) {
      this.logger.info('Article sub already existed, unsub before continue.');
      this.clearArticleSub();
    }

    // Skip if the subscription is already added.
    // if (this.subscriptions.findIndex((s) => s.id == id) > -1) {
    //   debugger;
    //   this.logger.info('This subscription is already added!');
    //   return;
    // }

    const filter = { kinds: [kinds.LongFormArticle], authors: ids };
    const sub = this.relay.subscribe([filter], {

      onevent: (event: Event) => {
        this.logger.info('POST MESSAGE BACK TO MAIN');
        postMessage({ url: this.url, type: 'event', data: event } as RelayResponse);
        this.logger.info('FINISHED POST MESSAGE BACK TO MAIN');
      },

      oneose: () => {
        this.logger.info('eose on event.');
        clearTimeout(this.articleTimer);
        this.clearArticleSub();
        this.queue.queues.article.active = false;
        this.processArticle();
      }



    }) as NostrSubscription;
    this.articleSub = sub;

    // sub.on('event', (originalEvent: any) => {
    //   this.logger.info('POST MESSAGE BACK TO MAIN');
    //   postMessage({ url: this.url, type: 'event', data: originalEvent } as RelayResponse);
    //   this.logger.info('FINISHED POST MESSAGE BACK TO MAIN');
    // });

    // sub.on('eose', () => {
    //   this.logger.info('eose on event.');
    //   clearTimeout(this.articleTimer);
    //   this.clearArticleSub();
    //   this.queue.queues.article.active = false;
    //   this.processArticle();
    // });

    this.logger.info('REGISTER TIMEOUT!!', timeoutSeconds * 1000);

    this.articleTimer = setTimeout(() => {
      this.logger.warn(`${this.url}: Event download timeout reached.`);
      this.clearArticleSub();
      this.queue.queues.article.active = false;
      this.processArticle();

      postMessage({ url: this.url, type: 'timeout', data: { type: 'Event', identifier: ids } } as RelayResponse);

      // if (!finalizedCalled) {
      //   finalizedCalled = true;
      //   finalized();
      // }
    }, timeoutSeconds * 1000);
  }

  downloadBadgeDefinition(ids: string[], timeoutSeconds: number = 12) {
    this.logger.info('DOWNLOAD BADGE DEFINITION....');

    if (!this.relay) {
      debugger;
      this.logger.warn('This relay does not have active connection and download cannot be executed at this time.');
      return;
    }

    // If the profilesub already exists, unsub and remove.
    if (this.badgeDefinitionSub) {
      this.logger.info('Article sub already existed, unsub before continue.');
      this.clearBadgeDefinitionSub();
    }

    // Skip if the subscription is already added.
    // if (this.subscriptions.findIndex((s) => s.id == id) > -1) {
    //   debugger;
    //   this.logger.info('This subscription is already added!');
    //   return;
    // }

    const filters: Filter[] = [];

    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      const lines = id.split(':');
      const pubkey = lines[1];

      // In case there is a ':' value within the slug, we get the slug like this:
      const slug = id.replace('30009:', '').replace(pubkey + ':', '');
      filters.push({ kinds: [30009], authors: [pubkey], ['#d']: [slug] });
    }

    const sub = this.relay.subscribe(filters, {

      onevent: (event: Event) => {
        this.logger.info('POST MESSAGE BACK TO MAIN');
        postMessage({ url: this.url, type: 'event', data: event } as RelayResponse);
        this.logger.info('FINISHED POST MESSAGE BACK TO MAIN');
      },


      oneose: () => {
        this.logger.info('eose on event.');
        clearTimeout(this.badgeDefinitionTimer);
        this.clearBadgeDefinitionSub();
        this.queue.queues.badgedefinition.active = false;
        this.processBadgeDefinition();
      }




    }) as NostrSubscription;
    this.badgeDefinitionSub = sub;

    // sub.on('event', (originalEvent: any) => {
    //   this.logger.info('POST MESSAGE BACK TO MAIN');
    //   postMessage({ url: this.url, type: 'event', data: originalEvent } as RelayResponse);
    //   this.logger.info('FINISHED POST MESSAGE BACK TO MAIN');
    // });

    // sub.on('eose', () => {
    //   this.logger.info('eose on event.');
    //   clearTimeout(this.badgeDefinitionTimer);
    //   this.clearBadgeDefinitionSub();
    //   this.queue.queues.badgedefinition.active = false;
    //   this.processBadgeDefinition();
    // });

    this.logger.info('REGISTER TIMEOUT!!', timeoutSeconds * 1000);

    this.badgeDefinitionTimer = setTimeout(() => {
      this.logger.warn(`${this.url}: Event download timeout reached.`);
      this.clearBadgeDefinitionSub();
      this.queue.queues.badgedefinition.active = false;
      this.processBadgeDefinition();

      postMessage({ url: this.url, type: 'timeout', data: { type: 'Event', identifier: ids } } as RelayResponse);

      // if (!finalizedCalled) {
      //   finalizedCalled = true;
      //   finalized();
      // }
    }, timeoutSeconds * 1000);
  }

  download(filters: Filter[], id: string, type: string = 'Event', timeoutSeconds: number = 12) {
    if (!this.relay) {
      this.logger.warn('This relay does not have active connection and download cannot be executed at this time.');
      return;
    }

    let sub: NostrSubscription | undefined = this.relay.subscribe(filters, {

      onevent: (event: Event) => {
        postMessage({ url: this.url, type: 'event', data: event, subscription: id } as RelayResponse);

      },

      oneose: () => {
        clearTimeout(timer);

        if (sub) {
          sub.close();
          sub = undefined;
        }
      },


    }) as NostrSubscription;

    // sub.on('event', (originalEvent: any) => {
    // });

    // sub.on('eose', () => {
      
    // });

    const timer = setTimeout(() => {
      if (sub) {
        sub.close();
        sub = undefined;
      }

      postMessage({ url: this.url, type: 'timeout', data: { type, filters } } as RelayResponse);
    }, timeoutSeconds * 1000);
  }

  downloadEvent(ids: string[], timeoutSeconds: number = 12) {
    this.logger.info('DOWNLOAD EVENT....');
    let finalizedCalled = false;

    if (!this.relay) {
      debugger;
      this.logger.warn('This relay does not have active connection and download cannot be executed at this time.');
      return;
    }

    // If the profilesub already exists, unsub and remove.
    if (this.eventSub) {
      this.logger.info('Event sub already existed, unsub before continue.');
      this.clearEventSub();
    }

    // Skip if the subscription is already added.
    // if (this.subscriptions.findIndex((s) => s.id == id) > -1) {
    //   debugger;
    //   this.logger.info('This subscription is already added!');
    //   return;
    // }

    const kindsList = [kinds.ShortTextNote];

    const sub = this.relay.subscribe([{ kinds: kindsList, ids: ids }], {

      onevent: (event: Event) => {
        this.logger.info('POST MESSAGE BACK TO MAIN');
        postMessage({ url: this.url, type: 'event', data: event } as RelayResponse);
        this.logger.info('FINISHED POST MESSAGE BACK TO MAIN');
      },

      oneose: () => {
        this.logger.info('eose on event.');
        clearTimeout(this.eventTimer);
        this.clearEventSub();
        this.queue.queues.event.active = false;
        this.processEvents();
      }


    }) as NostrSubscription;
    this.eventSub = sub;

    // sub.on('event', (originalEvent: any) => {
    //   this.logger.info('POST MESSAGE BACK TO MAIN');
    //   postMessage({ url: this.url, type: 'event', data: originalEvent } as RelayResponse);
    //   this.logger.info('FINISHED POST MESSAGE BACK TO MAIN');
    // });

    // sub.on('eose', () => {
    //   this.logger.info('eose on event.');
    //   clearTimeout(this.eventTimer);
    //   this.clearEventSub();
    //   this.queue.queues.event.active = false;
    //   this.processEvents();
    // });

    this.logger.info('REGISTER TIMEOUT!!', timeoutSeconds * 1000);

    this.eventTimer = setTimeout(() => {
      this.logger.warn(`${this.url}: Event download timeout reached.`);
      this.clearEventSub();
      this.queue.queues.event.active = false;
      this.processEvents();

      postMessage({ url: this.url, type: 'timeout', data: { type: 'Event', identifier: ids } } as RelayResponse);

      // if (!finalizedCalled) {
      //   finalizedCalled = true;
      //   finalized();
      // }
    }, timeoutSeconds * 1000);
  }

  subscribe(filters: Filter[], id: string) {
    if (!this.relay || !this.relay.connected) {
      // If we don't have a connection yet, schedule the subscription to be added later.
      this.queue.queues.subscriptions.jobs.push({ id: id, filters: filters, type: 'Event', events: [] });
      this.logger.warn('This relay does not have active connection and subscription cannot be created at this time. Subscription has been scheduled for adding later.');
      return;
    }

    // Skip if the subscription is already added.
    if (this.subscriptions.findIndex((s) => s.id == id) > -1) {
      this.logger.info('This subscription is already added!');
      return;
    }

    const sub = this.relay.subscribe(filters, {

      onevent: (event: Event) => {
        postMessage({ url: this.url, subscription: id, type: 'event', data: event } as RelayResponse);
      },

      oneose: () => {
        this.logger.info('eose on event.');
        // clearTimeout(this.eventTimer);
        // this.clearEventSub();
        // this.queue.queues.event.active = false;
        // this.processEvents();
      },

    }) as NostrSubscription;
    // sub.id = id;

    this.logger.info('SUBSCRIPTION:', sub);
    this.subscriptions.push({ id: id, filters: filters, sub: sub, type: 'Event', events: [] });

    // const sub = relay.sub(filters, {}) as NostrSubscription;
    // relay.subscriptions.push(sub);

    // sub.on('event', (originalEvent: any) => {
    //   postMessage({ url: this.url, subscription: id, type: 'event', data: originalEvent } as RelayResponse);
    //   // const event = this.eventService.processEvent(originalEvent);
    //   // if (!event) {
    //   //   return;
    //   // }
    //   // observer.next(event);
    // });

    // sub.on('eose', () => {
    //   this.logger.info('eose on:', this.url);
    // });

    // return () => {
    //   this.logger.info('subscribeToRelay:finished:unsub');
    //   // When the observable is finished, this return function is called.
    //   sub.unsub();
    //   const subIndex = relay.subscriptions.findIndex((s) => s == sub);
    //   if (subIndex > -1) {
    //     relay.subscriptions.splice(subIndex, 1);
    //   }
    // };
  }

  async info() {
    try {
      const url = new URL(this.url);
      let protocol = url.protocol === 'ws:' ? 'http' : 'https';

      const infoUrl = `${protocol}://${url.host}`;
      const rawResponse = await fetch(infoUrl, {
        method: 'GET',
        mode: 'cors',
        headers: {
          Accept: 'application/nostr+json',
        },
      });
      if (rawResponse.status === 200) {
        const content = await rawResponse.json();
        // Keep a local reference to the NIP11 info on the relay instance.
        this.relay.nip11 = content;
        postMessage({ type: 'nip11', data: content, url: this.url } as RelayResponse);
      } else {
        postMessage({ type: 'nip11', data: { error: `Unable to get NIP-11 data. Status: ${rawResponse.statusText}` }, url: this.url } as RelayResponse);
      }
    } catch (err) {
      this.logger.warn(err);
      postMessage({ type: 'nip11', data: { error: `Unable to get NIP-11 data. Status: ${err}` }, url: this.url } as RelayResponse);
    }
  }
}
