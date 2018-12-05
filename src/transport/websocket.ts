import {
  ElementsHeaders,
  ErrorResponse,
  NetworkError,
  responseToHeadersObject,
} from '../network';
import {
  Subscription,
  SubscriptionEvent,
  SubscriptionListeners,
  SubscriptionTransport,
} from '../subscription';

type WsMessageType = number;
type Message = any[];

const SubscribeMessageType: WsMessageType = 100;
const OpenMessageType: WsMessageType = 101;
const EventMessageType: WsMessageType = 102;
const UnsubscribeMessageType: WsMessageType = 198;
const EosMessageType: WsMessageType = 199;
const PingMessageType: WsMessageType = 16;
const PongMessageType: WsMessageType = 17;
const CloseMessageType: WsMessageType = 99;

export enum WSReadyState {
  Connecting = 0,
  Open,
  Closing,
  Closed,
}

type SubscriptionData = {
  path: string;
  listeners: SubscriptionListeners;
  headers: ElementsHeaders;
  subID?: number;
};

type WsSubscriptionsType = {
  [key: number]: SubscriptionData;
};

class WsSubscriptions {
  private subscriptions: WsSubscriptionsType;
  private pendingSubscriptions: WsSubscriptionsType;

  constructor() {
    this.subscriptions = {};
  }

  add(
    subID: number,
    path: string,
    listeners: SubscriptionListeners,
    headers: ElementsHeaders,
  ): number {
    this.subscriptions[subID] = {
      headers,
      listeners,
      path,
    };

    return subID;
  }

  has(subID: number): boolean {
    return this.subscriptions[subID] !== undefined;
  }

  isEmpty(): boolean {
    return Object.keys(this.subscriptions).length === 0;
  }

  remove(subID: number): boolean {
    return delete this.subscriptions[subID];
  }

  get(subID: number): SubscriptionData {
    return this.subscriptions[subID];
  }

  getAll(): WsSubscriptionsType {
    return this.subscriptions;
  }

  getAllAsArray(): SubscriptionData[] {
    return Object.keys(this.subscriptions).map(subID => ({
      subID: parseInt(subID, 10),
      ...this.subscriptions[parseInt(subID, 10)],
    }));
  }

  removeAll() {
    this.subscriptions = {};
  }
}

class WsSubscription implements Subscription {
  constructor(private wsTransport: WebSocketTransport, private subID: number) {}

  unsubscribe() {
    this.wsTransport.unsubscribe(this.subID);
  }
}

const pingIntervalMs: number = 30000;
const pingTimeoutMs: number = 10000;

export default class WebSocketTransport implements SubscriptionTransport {
  private baseURL: string;
  private webSocketPath: string = '/ws';
  private socket: WebSocket;
  private forcedClose: boolean = false;
  private closedError: any = null;
  private lastSubscriptionID: number;
  private subscriptions: WsSubscriptions;
  private pendingSubscriptions: WsSubscriptions;
  private lastMessageReceivedTimestamp: number;
  private pingInterval: any;
  private pongTimeout: any;
  private lastSentPingID: number | null;

  constructor(host: string) {
    this.baseURL = `wss://${host}${this.webSocketPath}`;
    this.lastSubscriptionID = 0;
    this.subscriptions = new WsSubscriptions();
    this.pendingSubscriptions = new WsSubscriptions();

    this.connect();
  }

  subscribe(
    path: string,
    listeners: SubscriptionListeners,
    headers: ElementsHeaders,
  ): Subscription {
    global.console.log("At the top of subscribe");

    // If connection was closed, try to reconnect
    this.tryReconnectIfNeeded();

    const subID = this.lastSubscriptionID++;

    // Add subscription to pending if socket is not open
    if (this.socket.readyState !== WSReadyState.Open) {
      global.console.log(`Adding PENDING subscription ${subID} for path: ${path}`);
      this.pendingSubscriptions.add(subID, path, listeners, headers);
      return new WsSubscription(this, subID);
    }

    // Add or select subscription
    global.console.log(`Adding subscription ${subID} for path: ${path}`);
    this.subscriptions.add(subID, path, listeners, headers);

    this.sendMessage(
      this.getMessage(SubscribeMessageType, subID, path, headers),
    );

    return new WsSubscription(this, subID);
  }

  unsubscribe(subID: number): void {
    this.sendMessage(this.getMessage(UnsubscribeMessageType, subID));

    const subscription = this.subscriptions.get(subID);
    if (subscription.listeners.onEnd) {
      subscription.listeners.onEnd(null);
    }
    this.subscriptions.remove(subID);
  }

  private connect() {
    global.console.log("At the top of connect");

    this.forcedClose = false;
    this.closedError = null;

    this.socket = new global.WebSocket(this.baseURL);

    this.socket.onopen = (event: any) => {
      global.console.log("At the top of socket onopen");

      const allPendingSubscriptions = this.pendingSubscriptions.getAllAsArray();

      global.console.log(`allPendingSubscriptions.length: ${allPendingSubscriptions.length}`);
      global.console.log(allPendingSubscriptions);

      // Re-subscribe old subscriptions for new connection
      allPendingSubscriptions.forEach(subscription => {
        const { subID, path, listeners, headers } = subscription;
        this.subscribePending(path, listeners, headers, subID);
      });

      this.pendingSubscriptions.removeAll();

      this.pingInterval = global.setInterval(() => {
        if (this.pongTimeout) {
          return;
        }

        const now = new Date().getTime();

        if (pingTimeoutMs > now - this.lastMessageReceivedTimestamp) {
          return;
        }

        this.sendMessage(this.getMessage(PingMessageType, now));

        this.lastSentPingID = now;

        this.pongTimeout = global.setTimeout(() => {
          const pongNow = new Date().getTime();

          if (pingTimeoutMs > pongNow - this.lastMessageReceivedTimestamp) {
            this.pongTimeout = null;
            return;
          }

          global.console.log(`Calling close because pong response timeout`);
          this.close(
            new NetworkError(`Pong response wasn't received until timeout.`),
          );
        }, pingTimeoutMs);
      }, pingIntervalMs);
    };

    this.socket.onmessage = (event: any) => this.receiveMessage(event);
    this.socket.onerror = (event: any) => {
      global.console.log("Received an error in onerror");
      global.console.log(event);

      // TODO: We don't need to call close ourselves, but maybe we do need to set forcedClose to true?
      // this.close(new NetworkError('Connection was lost.'));
    };
    this.socket.onclose = (event: any) => {
      global.console.log(`At the top of onclose, about to call trace`);
      global.console.trace();
      global.console.log(`Trace end`);

      global.console.log(`Is there a closedError?`);
      global.console.log(this.closedError);

      const callback = this.closedError
        ? (subscription: SubscriptionData) => {
            if (subscription.listeners.onError) {
              subscription.listeners.onError(this.closedError);
            }
          }
        : (subscription: SubscriptionData) => {
            if (subscription.listeners.onEnd) {
              subscription.listeners.onEnd(null);
            }
          };

      global.console.log(`Pending subscriptions empty?: ${this.pendingSubscriptions.isEmpty()}`);
      global.console.log(this.pendingSubscriptions);
      global.console.log(`this.subscriptions list:`);
      global.console.log(this.subscriptions);

      const allSubscriptions =
        this.pendingSubscriptions.isEmpty()
          ? this.subscriptions
          : this.pendingSubscriptions;

      allSubscriptions.getAllAsArray().forEach(callback);
      allSubscriptions.removeAll();

      global.console.log("Forced close and in onclose and there was a closedError so we will go to tryReconnectIfNeeded");
      this.tryReconnectIfNeeded();
    };
  }

  private close(error?: any) {
    if (!(this.socket instanceof global.WebSocket)) {
      return;
    }

    global.console.log(`Doing a forced close`);

    // In Chrome there is a substantial delay between calling close on a broken
    // websocket and the onclose method firing. When we're force closing the
    // connection we can expedite the reconnect process by manually calling
    // onclose. We then need to delete the socket's handlers so that we don't
    // get extra calls from the dying socket.
    const onClose = this.socket.onclose.bind(this);

    delete this.socket.onclose;
    delete this.socket.onerror;
    delete this.socket.onmessage;
    delete this.socket.onopen;

    this.forcedClose = true;
    this.closedError = error;
    global.console.log(`THIS.SOCKET.CLOSE ABOUT TO BE CALLED`);
    this.socket.close();

    global.clearTimeout(this.pingInterval);
    global.clearTimeout(this.pongTimeout);
    delete this.pongTimeout;
    this.lastSentPingID = null;

    onClose();
  }

  private tryReconnectIfNeeded() {
    // If we've force closed, the socket might not actually be in the Closed
    // state yet but we should create a new one anyway.
    if (this.forcedClose || this.socket.readyState === WSReadyState.Closed) {
      global.console.log(`About to try to (re)connect`);
      this.connect();
    }
  }

  private subscribePending(
    path: string,
    listeners: SubscriptionListeners,
    headers: ElementsHeaders,
    subID?: number,
  ) {
    if (subID === undefined) {
      global.console.log(`Subscription to path ${path} has an undefined ID`);
      return;
    }

    // Add or select subscription
    this.subscriptions.add(subID, path, listeners, headers);

    this.sendMessage(
      this.getMessage(SubscribeMessageType, subID, path, headers),
    );
  }

  private getMessage(
    messageType: WsMessageType,
    id: number,
    path?: string,
    headers?: ElementsHeaders,
  ): Message {
    return [messageType, id, path, headers];
  }

  private sendMessage(message: Message) {
    if (this.socket.readyState !== WSReadyState.Open) {
      return global.console.warn(
        `Can't send in "${WSReadyState[this.socket.readyState]}" state`,
      );
    }

    this.socket.send(JSON.stringify(message));
  }

  private subscription(subID: number) {
    return this.subscriptions.get(subID);
  }

  private receiveMessage(event: any) {
    this.lastMessageReceivedTimestamp = new Date().getTime();

    // First try to parse event to JSON message.
    let message: Message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      global.console.log(`Calling close because invalid JSON in message`);
      this.close(
        new Error(`Message is not valid JSON format. Getting ${event.data}`),
      );
      return;
    }

    // Validate structure of message.
    // Close connection if not valid.
    const nonValidMessageError = this.validateMessage(message);
    if (nonValidMessageError) {
      global.console.log(`Calling close because message is invalid`);
      this.close(new Error(nonValidMessageError.message));
      return;
    }

    const messageType = message.shift();

    // Try to handle connection level messages first
    switch (messageType) {
      case PongMessageType:
        this.onPongMessage(message);
        return;
      case PingMessageType:
        this.onPingMessage(message);
        return;
      case CloseMessageType:
        this.onCloseMessage(message);
        return;
    }

    const subID = message.shift();
    const subscription = this.subscription(subID);

    if (!subscription) {
      global.console.log(`Calling close because no subscription found for subID ${subID}`);
      this.close(
        new Error(
          `Received message for non existing subscription id: "${subID}"`,
        ),
      );
      return;
    }

    const { listeners } = subscription;

    // Handle subscription level messages.
    switch (messageType) {
      case OpenMessageType:
        this.onOpenMessage(message, subID, listeners);
        break;
      case EventMessageType:
        this.onEventMessage(message, listeners);
        break;
      case EosMessageType:
        this.onEOSMessage(message, subID, listeners);
        break;
      default:
        global.console.log(`Calling close because of invalid message type`);
        this.close(new Error('Received non existing type of message.'));
    }
  }

  /**
   * Check if a single subscription message is in the right format.
   * @param message The message to check.
   * @returns null or error if the message is wrong.
   */
  private validateMessage(message: Message): Error | null {
    if (!Array.isArray(message)) {
      return new Error(
        `Message is expected to be an array. Getting: ${JSON.stringify(
          message,
        )}`,
      );
    }

    if (message.length < 1) {
      return new Error(`Message is empty array: ${JSON.stringify(message)}`);
    }

    return null;
  }

  private onOpenMessage(
    message: Message,
    subID: number,
    subscriptionListeners: SubscriptionListeners,
  ) {
    if (subscriptionListeners.onOpen) {
      subscriptionListeners.onOpen(message[1]);
    }
  }

  private onEventMessage(
    eventMessage: Message,
    subscriptionListeners: SubscriptionListeners,
  ): Error | void {
    if (eventMessage.length !== 3) {
      return new Error(
        'Event message has ' + eventMessage.length + ' elements (expected 4)',
      );
    }

    const [eventId, headers, body] = eventMessage;
    if (typeof eventId !== 'string') {
      return new Error(
        `Invalid event ID in message: ${JSON.stringify(eventMessage)}`,
      );
    }

    if (typeof headers !== 'object' || Array.isArray(headers)) {
      return new Error(
        `Invalid event headers in message: ${JSON.stringify(eventMessage)}`,
      );
    }

    if (subscriptionListeners.onEvent) {
      subscriptionListeners.onEvent({ eventId, headers, body });
    }
  }

  private onEOSMessage(
    eosMessage: Message,
    subID: number,
    subscriptionListeners: SubscriptionListeners,
  ): void {
    global.console.log(`Received EOS message for sub ${subID}`);
    this.subscriptions.remove(subID);

    if (eosMessage.length !== 3) {
      if (subscriptionListeners.onError) {
        subscriptionListeners.onError(
          new Error(
            `EOS message has ${eosMessage.length} elements (expected 4)`,
          ),
        );
      }
      return;
    }

    const [statusCode, headers, body] = eosMessage;
    if (typeof statusCode !== 'number') {
      if (subscriptionListeners.onError) {
        subscriptionListeners.onError(new Error('Invalid EOS Status Code'));
      }
      return;
    }

    if (typeof headers !== 'object' || Array.isArray(headers)) {
      if (subscriptionListeners.onError) {
        subscriptionListeners.onError(new Error('Invalid EOS ElementsHeaders'));
      }
      return;
    }

    if (statusCode === 204) {
      if (subscriptionListeners.onEnd) {
        subscriptionListeners.onEnd(null);
      }
      return;
    }

    if (subscriptionListeners.onError) {
      subscriptionListeners.onError(
        new ErrorResponse(statusCode, headers, body),
      );
    }

    return;
  }

  private onCloseMessage(closeMessage: Message) {
    const [statusCode, headers, body] = closeMessage;
    if (typeof statusCode !== 'number') {
      global.console.log(`Calling close because of invalid EOS Status Code`);
      return this.close(new Error('Close message: Invalid EOS Status Code'));
    }

    if (typeof headers !== 'object' || Array.isArray(headers)) {
      global.console.log(`Calling close because of invalid EOS ElementsHeaders`);
      return this.close(
        new Error('Close message: Invalid EOS ElementsHeaders'),
      );
    }

    global.console.log(`Calling close because at end of onCloseMessage function`);

    const errorInfo = {
      error: body.error || 'network_error',
      error_description: body.error_description || 'Network error',
    };

    this.close(new ErrorResponse(statusCode, headers, errorInfo));
  }

  private onPongMessage(message: Message) {
    const [receviedPongID] = message;

    if (this.lastSentPingID !== receviedPongID) {
      global.console.warn(
        `Received pong with ID ${receviedPongID} but lastSentPingID was ${
          this.lastSentPingID
        }`,
      );
    }

    global.console.log(`Received pong ID ${receviedPongID}`);

    global.clearTimeout(this.pongTimeout);
    delete this.pongTimeout;
    this.lastSentPingID = null;
  }

  private onPingMessage(message: Message) {
    const [receviedPingID] = message;

    global.console.log(`Received ping ID ${receviedPingID}`);

    this.sendMessage(this.getMessage(PongMessageType, receviedPingID));
  }
}
