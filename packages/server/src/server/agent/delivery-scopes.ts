import { randomUUID } from "node:crypto";

export class DeliveryRevokedError extends Error {
  constructor() {
    super("The delivery scope is revoked or no longer belongs to this connection.");
  }
}

/** A daemon-local admission barrier. Scope IDs never become valid again after restart. */
export class DeliveryScope {
  readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly deliveries = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  settled = false;
  constructor(
    readonly id: string,
    readonly pluginId: string,
    readonly connectionId: string,
  ) {}
  get signal() {
    return this.controller.signal;
  }
  assertActive() {
    if (this.signal.aborted) throw new DeliveryRevokedError();
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    return this.own(this.pending, operation);
  }

  // Checking validity and acquiring provider execution rights happen in one synchronous step.
  enter<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    return this.own(this.deliveries, operation);
  }

  private own<T>(set: Set<Promise<unknown>>, operation: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(operation);
    set.add(result);
    void result.finally(() => set.delete(result)).catch(() => undefined);
    return result;
  }

  revoke(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort(new DeliveryRevokedError());
    this.closing = Promise.allSettled([...this.pending, ...this.deliveries]).then(() => {
      this.settled = true;
      return undefined;
    });
    return this.closing;
  }
}

export class DeliveryScopes {
  private readonly scopes = new Map<string, DeliveryScope>();
  private readonly closedConnections = new Set<string>();
  private closed = false;

  create(pluginId: string, connectionId: string) {
    if (this.closed || this.closedConnections.has(connectionId)) throw new DeliveryRevokedError();
    const scope = new DeliveryScope(randomUUID(), pluginId, connectionId);
    this.scopes.set(scope.id, scope);
    return { id: scope.id, status: "active" as const };
  }

  get(pluginId: string, id: string) {
    const scope = this.scopes.get(id);
    if (scope && scope.pluginId !== pluginId)
      throw new Error("Delivery scope belongs to another plugin.");
    if (!scope) return { id, status: "not_found" as const };
    if (scope.settled) return { id, status: "revoked" as const };
    if (scope.signal.aborted) return { id, status: "revoking" as const };
    return { id, status: "active" as const };
  }

  require(pluginId: string, connectionId: string, id: string): DeliveryScope {
    this.get(pluginId, id);
    const scope = this.scopes.get(id);
    if (!scope || scope.connectionId !== connectionId) throw new DeliveryRevokedError();
    scope.assertActive();
    return scope;
  }

  async revoke(pluginId: string, id: string) {
    this.get(pluginId, id);
    await this.scopes.get(id)?.revoke();
    return this.get(pluginId, id);
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.scopes.values()].map((scope) => scope.revoke()));
  }

  async closeConnection(connectionId: string) {
    this.closedConnections.add(connectionId);
    await Promise.all(
      [...this.scopes.values()]
        .filter((scope) => scope.connectionId === connectionId)
        .map((scope) => scope.revoke()),
    );
  }
}

export function enterDelivery<T>(
  scope: DeliveryScope | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return scope ? scope.enter(operation) : operation();
}
