import { TokenProvider } from './token-provider';
import { BaseClient } from './base-client';
import { RequestOptions } from './base-client';
import { Subscription, SubscribeOptions } from './subscription';
import { ResumableSubscription, ResumableSubscribeOptions } from './resumable-subscription'; 

const DEFAULT_CLUSTER = "api-ceres.kube.pusherplatform.io";

export interface AppOptions {

    serviceId: string;
    tokenProvider?: TokenProvider;
    client?: BaseClient;
    cluster?: string;
    encrypted?: boolean;
}

type Response = any;

export default class App {

    private client: BaseClient;

    private serviceId: string;
    private tokenProvider: TokenProvider;

    constructor(options: AppOptions) {
        this.serviceId = options.serviceId;
        this.tokenProvider = options.tokenProvider;
        this.client = options.client || new BaseClient({
            cluster: options.cluster || DEFAULT_CLUSTER,
            encrypted: options.encrypted
        });
    }

    request(options: RequestOptions): Promise<any> {
        options.path = this.absPath(options.path);
        const tokenProvider = options.tokenProvider || this.tokenProvider;
        if (!options.jwt && tokenProvider) {
            return tokenProvider.provideToken().then((jwt) => {
                return this.client.request({ jwt, ...options });
            });
        } else {
            return this.client.request(options);
        }
    }

    subscribe(options: SubscribeOptions): Subscription {
        options.path = this.absPath(options.path);

        let subscription: Subscription = this.client.newSubscription(options);

        const tokenProvider = options.tokenProvider || this.tokenProvider;
        if (options.jwt) {
            subscription.open(options.jwt);
        } else if (tokenProvider) {
            tokenProvider.provideToken().then((jwt) => {
                subscription.open(jwt);
            }).catch((err) => {
                subscription.unsubscribe(err);
            });
        } else {
            subscription.open(null);
        }

        return subscription;
    }

    resumableSubscribe(options: ResumableSubscribeOptions): ResumableSubscription {
        options.path = this.absPath(options.path);
        const authorizer = options.tokenProvider || this.tokenProvider;

        let resumableSubscription: ResumableSubscription =
            this.client.newResumableSubscription({ authorizer, ...options });

        resumableSubscription.open();

        return resumableSubscription;
    }

    private absPath(relativePath: string): string {
        return `/apps/${this.serviceId}/${relativePath}`.replace(/\/+/g, "/").replace(/\/+$/, "");
    }
}
