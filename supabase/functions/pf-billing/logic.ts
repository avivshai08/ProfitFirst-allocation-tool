// Billing rules for the allocation tool, ported from MoneySystem (src/server/billing-check.ts)
// so both products treat SUMIT standing orders the same way. Pure functions plus three
// flows that take their database and SUMIT access as arguments, so they can be tested
// without either.

/** SUMIT `RecurringCustomerItemStatus`. */
export const STATUS = {
  Active: 0,
  Cancelled: 1,
  DisabledFailedBillingPayment: 3,
  FinishedExpired: 9,
  GracePeriod: 11,
  PendingForFirstPayment: 12,
  CancelledByCustomer: 13,
  PendingRetry: 14,
} as const;

/** Days of access after a failed charge before it stops. */
export const PAYMENT_GRACE_DAYS = 5;
/** How long a signup still awaiting payment is re-checked daily (Bit, or a closed tab). */
export const PENDING_SIGNUP_DAYS = 7;

/** Paying: an active order, or the free trial before its first charge. */
const PAYING: number[] = [STATUS.Active, STATUS.PendingForFirstPayment];
const FAILING: number[] = [STATUS.PendingRetry, STATUS.GracePeriod, STATUS.DisabledFailedBillingPayment];
export const ENDED: number[] = [STATUS.Cancelled, STATUS.CancelledByCustomer, STATUS.FinishedExpired];

export type RecurringItem = {
  id: number;
  itemId: number | null;
  status: number;
  firstBilling: string | null;
  previousBilling: string | null;
};
export type BillingState = 'paying' | 'failing' | 'cancelled' | 'unknown';

/** Which SUMIT customer: a self-signup by our client id, an admin-added client by customer number. */
export type SumitCustomer = { externalId: string } | { customerId: string };

export type ClientRow = {
  id: string;
  name: string;
  email: string;
  signup_source: string | null;
  sumit_customer_id: string | null;
  awaiting_payment: boolean;
  subscription_end: string | null;
  sumit_end_date: string | null;
  subscription_cancelled_at: string | null;
  created_at: string;
};

export interface Sumit {
  list(customer: SumitCustomer, includeInactive: boolean): Promise<RecurringItem[]>;
  cancel(customer: SumitCustomer, recurringItemId: number): Promise<void>;
}
export interface Clients {
  byUserId(userId: string): Promise<ClientRow | null>;
  pendingSince(isoDate: string): Promise<ClientRow[]>;
  billed(): Promise<ClientRow[]>;
  update(id: string, values: Partial<ClientRow> & { active?: boolean }): Promise<void>;
}

/** A self-signup's SUMIT customer carries this as its external identifier. */
export function externalIdOf(clientId: string) {
  return 'pf-' + clientId;
}

export function sumitCustomerOf(row: Pick<ClientRow, 'id' | 'signup_source' | 'sumit_customer_id'>): SumitCustomer | null {
  if (row.sumit_customer_id) return { customerId: row.sumit_customer_id };
  return row.signup_source === 'self' ? { externalId: externalIdOf(row.id) } : null;
}

/** Only this tool's catalog item counts: the same SUMIT account also bills MoneySystem. */
export function ofThisProduct(items: RecurringItem[], productItemId: number) {
  return items.filter((item) => item.itemId === productItemId);
}

export function billingState(items: RecurringItem[]): BillingState {
  if (items.some((item) => PAYING.includes(item.status))) return 'paying';
  if (items.some((item) => FAILING.includes(item.status))) return 'failing';
  if (items.some((item) => ENDED.includes(item.status))) return 'cancelled';
  return 'unknown';
}

function addDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function addMonth(iso: string) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

/** After a cancellation: a month after the last payment, or the trial end; never before today. */
export function paidUntil(items: RecurringItem[], today: string): string {
  const ends = items
    .filter((item) => ENDED.includes(item.status))
    .map((item) => (item.previousBilling ? addMonth(item.previousBilling) : item.firstBilling))
    .filter((end): end is string => end !== null);
  return [today, ...ends].sort().at(-1)!;
}

/** End dates are stored like the admin screen stores them: the last second of the day. */
export function endOfDay(isoDate: string) {
  return `${isoDate}T23:59:59`;
}
function dateOf(value: string | null) {
  return value ? value.slice(0, 10) : null;
}

type EndDates = { endDate: string | null; sumitEndDate: string | null };

/**
 * An end date the app did not set (the admin's) is never changed. With no end date, a
 * failed charge gives PAYMENT_GRACE_DAYS more days; a cancellation ends access when the
 * paid period does; a later successful payment clears a date the app set. An end date
 * the app already set is otherwise left alone.
 * Dates are YYYY-MM-DD. Returns the new dates, or null for no change.
 */
export function nextEndDates(current: EndDates, state: BillingState, items: RecurringItem[], today: string): EndDates | null {
  const appOwned = current.sumitEndDate !== null && current.endDate === current.sumitEndDate;
  if (current.endDate !== null && !appOwned) return null;
  if (state === 'paying') {
    return current.endDate === null && current.sumitEndDate === null ? null : { endDate: null, sumitEndDate: null };
  }
  if (state === 'failing') {
    if (appOwned) return null;
    const end = addDays(today, PAYMENT_GRACE_DAYS);
    return { endDate: end, sumitEndDate: end };
  }
  if (state === 'cancelled') {
    // Once set, keep it: paidUntil() is never before today, so recomputing an end date
    // that has passed would push it to "today" every day and access would never end.
    if (appOwned) return null;
    const end = paidUntil(items, today);
    return { endDate: end, sumitEndDate: end };
  }
  return null;
}

function currentDates(row: ClientRow): EndDates {
  return { endDate: dateOf(row.subscription_end), sumitEndDate: dateOf(row.sumit_end_date) };
}
function asColumns(next: EndDates) {
  return {
    subscription_end: next.endDate ? endOfDay(next.endDate) : null,
    sumit_end_date: next.sumitEndDate ? endOfDay(next.sumitEndDate) : null,
  };
}

/** Opens access for a signup awaiting payment once SUMIT shows a paying order for it. */
export async function confirmSignup(row: ClientRow, deps: { clients: Clients; sumit: Sumit; productItemId: number }) {
  if (!row.awaiting_payment) return true;
  // By our client id, unless the admin entered the customer number (SUMIT filed the
  // payment under an existing customer card).
  const customer = sumitCustomerOf(row) ?? { externalId: externalIdOf(row.id) };
  const items = ofThisProduct(await deps.sumit.list(customer, false), deps.productItemId);
  if (billingState(items) !== 'paying') return false;
  await deps.clients.update(row.id, { awaiting_payment: false, active: true, subscription_end: null, sumit_end_date: null });
  return true;
}

export type CancelResult = { ok: true; endDate: string | null } | { ok: false; error: string };

/** The client's own cancellation: stops future charges; access runs to the end of the paid period. */
export async function cancelSubscription(row: ClientRow, today: string, deps: { clients: Clients; sumit: Sumit; productItemId: number }): Promise<CancelResult> {
  const customer = sumitCustomerOf(row);
  if (!customer) return { ok: false, error: 'not_billed' };
  if (row.subscription_cancelled_at) return { ok: false, error: 'already_cancelled' };
  const live = ofThisProduct(await deps.sumit.list(customer, false), deps.productItemId).filter((item) => !ENDED.includes(item.status));
  if (live.length === 0) return { ok: false, error: 'no_live_order' };
  for (const item of live) await deps.sumit.cancel(customer, item.id);
  const cancelled = live.map((item) => ({ ...item, status: STATUS.CancelledByCustomer }));
  const next = nextEndDates(currentDates(row), 'cancelled', cancelled, today);
  await deps.clients.update(row.id, { subscription_cancelled_at: new Date().toISOString(), ...(next ? asColumns(next) : {}) });
  return { ok: true, endDate: next ? next.endDate : dateOf(row.subscription_end) };
}

export type DailyResult = { opened: number; changed: number; failed: number };

/**
 * Daily: opens recent signups whose payment went through without returning to the tool,
 * then applies nextEndDates to every SUMIT-billed client. Clients the admin manages by
 * hand (no self-signup, no customer number) are never looked at. One client's error is
 * logged and skipped, never applied.
 */
export async function runDaily(today: string, deps: { clients: Clients; sumit: Sumit; productItemId: number; log?: (m: string) => void }): Promise<DailyResult> {
  const result: DailyResult = { opened: 0, changed: 0, failed: 0 };
  const log = deps.log ?? console.error;
  for (const row of await deps.clients.pendingSince(addDays(today, -PENDING_SIGNUP_DAYS))) {
    try {
      if (await confirmSignup(row, deps)) result.opened += 1;
    } catch (e) {
      result.failed += 1;
      log(`confirm ${row.id}: ${e}`);
    }
  }
  for (const row of await deps.clients.billed()) {
    try {
      const customer = sumitCustomerOf(row)!;
      const items = ofThisProduct(await deps.sumit.list(customer, true), deps.productItemId);
      const next = nextEndDates(currentDates(row), billingState(items), items, today);
      if (!next) continue;
      await deps.clients.update(row.id, asColumns(next));
      result.changed += 1;
    } catch (e) {
      result.failed += 1;
      log(`check ${row.id}: ${e}`);
    }
  }
  return result;
}
