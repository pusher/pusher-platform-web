import { ErrorResponse, NetworkError } from './base-client';
import { ConsoleLogger, EmptyLogger, Logger } from './logger';

export interface RetryStrategy {
    checkIfRetryable(error: Error): Promise<Error>;
    cancel(): void; //Cancels any pending retries
    reset(): void; //Resets the retry counter
}

export interface RetryStrategyResult {}

export class Retry implements RetryStrategyResult {
    waitTimeMillis: number;
    constructor(waitTimeMillis: number){
        this.waitTimeMillis = waitTimeMillis;
    }
}

export class DoNotRetry implements RetryStrategyResult {
    error: Error;
    constructor(error: Error){
        this.error = error;
    }
}

export interface ExponentialBackoffRetryStrategyOptions {
    requestMethod: string;
    logger: Logger;
    retryUnsafeRequests?: boolean;        

    limit?: number;
    initialBackoffMillis?: number;
    maxBackoffMillis?: number;
}

export class ExponentialBackoffRetryStrategy implements RetryStrategy {

    private requestMethod: string;
    private logger: Logger;
    private retryUnsafeRequests: boolean = false;

    private limit: number = -1;
    private retryCount = 0;

    private maxBackoffMillis: number = 5000;
    private defaultBackoffMillis: number = 1000;
    private currentBackoffMillis: number = this.defaultBackoffMillis;

    private pendingTimeouts = new Set<number>();

    constructor(options: ExponentialBackoffRetryStrategyOptions){
        this.requestMethod = options.requestMethod;
        this.logger = options.logger;

        if(options.retryUnsafeRequests) 
            this.retryUnsafeRequests = options.retryUnsafeRequests

        //Backoff limits
        if(options.limit) this.limit = options.limit;
        if(options.initialBackoffMillis){
             this.currentBackoffMillis = options.initialBackoffMillis;
             this.defaultBackoffMillis = options.initialBackoffMillis;
        }
        if(options.maxBackoffMillis) 
            this.maxBackoffMillis = options.maxBackoffMillis;
    }

    checkIfRetryable(error: Error): Promise<any> {
        return new Promise((resolve, reject) => {

            let shouldRetry = this.shouldRetry(error);

            if(shouldRetry instanceof DoNotRetry){
                reject(error);
            }
            else if(shouldRetry instanceof Retry) {
                this.retryCount += 1;

                const timeout = window.setTimeout(() => {
                    this.pendingTimeouts.delete(timeout);
                    resolve();
                }, shouldRetry.waitTimeMillis);

                this.pendingTimeouts.add(timeout);
            }
        });
    }

    reset(): void {
        this.retryCount = 0;
        this.currentBackoffMillis = this.defaultBackoffMillis;
    }

    cancel(): void {
        this.pendingTimeouts.forEach( (timeout) => {
            window.clearTimeout(timeout);
            this.pendingTimeouts.delete(timeout)
        });        
    }

    private requestMethodIsSafe(): boolean {
        switch(this.requestMethod){
            case 'GET':
            case 'HEAD':
            case 'OPTIONS':
            case 'SUBSCRIBE':
                return true;
            default:
                return false;
        }
    }

    private shouldRetry(error: Error): RetryStrategyResult {
        this.logger.verbose(`${this.constructor.name}:  Error received`, error);
        
        if(this.retryCount >= this.limit && this.limit >= 0 ){
            this.logger.verbose(`${this.constructor.name}:  Retry count is over the maximum limit: ${this.limit}`);
            return new DoNotRetry(error);
        }

        if (error instanceof ErrorResponse && error.headers['Retry-After']){
                    this.logger.verbose(`${this.constructor.name}:  Retry-After header is present, retrying in ${error.headers['Retry-After']}`);
            return new Retry(parseInt(error.headers['Retry-After']) * 1000);
        } 

        if (error instanceof NetworkError || this.requestMethodIsSafe() || this.retryUnsafeRequests) {
            return this.shouldSafeRetry(error);
        }
    
        this.logger.verbose(`${this.constructor.name}: Error is not retryable`, error);
        return new DoNotRetry(error);
    }

    private shouldSafeRetry(error: Error){
        if(error instanceof NetworkError){
            this.logger.verbose(`${this.constructor.name}: It's a Network Error, will retry`, error);
            return new Retry(this.calulateMillisToRetry());
        }

        if(error instanceof ErrorResponse) {
            if(error.statusCode >= 500 && error.statusCode < 600){
                this.logger.verbose(`${this.constructor.name}: Error 5xx, will retry`);
                return new Retry(this.calulateMillisToRetry());
            }
            if(error.statusCode === 401){
                this.logger.verbose(`${this.constructor.name}: Error 401 - probably expired token, retrying immediately`);
                return new Retry(0) //Token expired - can retry immediately
            }
        }
        this.logger.verbose(`${this.constructor.name}: Error is not retryable`, error);
        return new DoNotRetry(error);
    }

    private calulateMillisToRetry(): number {
        
        if(this.currentBackoffMillis >= this.maxBackoffMillis || this.currentBackoffMillis * 2 >= this.maxBackoffMillis) {
            this.currentBackoffMillis = this.maxBackoffMillis;
        }
            
        else if(this.retryCount > 0){
            this.currentBackoffMillis = this.currentBackoffMillis * 2;
        }

        this.logger.verbose(`Retrying in ${this.currentBackoffMillis}ms`);
        return this.currentBackoffMillis;
    }
}

export type RetryableResult = {
    isRetryable: boolean;
    backoffMillis?: number;
}
