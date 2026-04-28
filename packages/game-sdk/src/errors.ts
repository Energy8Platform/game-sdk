/**
 * SDK Error types
 */

export class SDKError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SDKError';
    this.code = code;
    Object.setPrototypeOf(this, SDKError.prototype);
  }
}

export class TimeoutError extends SDKError {
  constructor(messageType: string, timeoutMs: number) {
    super(
      'TIMEOUT',
      `No response for "${messageType}" within ${timeoutMs}ms. ` +
        'Ensure the host (casino shell) is handling this message type.',
    );
    this.name = 'TimeoutError';
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

export class BridgeNotReadyError extends SDKError {
  constructor() {
    super(
      'BRIDGE_NOT_READY',
      'SDK has not been initialized. Call sdk.ready() first and await its result.',
    );
    this.name = 'BridgeNotReadyError';
    Object.setPrototypeOf(this, BridgeNotReadyError.prototype);
  }
}

export class BridgeDestroyedError extends SDKError {
  constructor() {
    super('BRIDGE_DESTROYED', 'SDK has been destroyed. Create a new instance.');
    this.name = 'BridgeDestroyedError';
    Object.setPrototypeOf(this, BridgeDestroyedError.prototype);
  }
}
