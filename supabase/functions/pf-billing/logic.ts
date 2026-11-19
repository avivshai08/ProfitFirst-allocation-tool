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
  /** The verified Google email the client signed up with (also prefilled on the payment page). */
  login_email: string | null;
  phone?: string | null;
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
  /** SUMIT customer numbers whose email is exactly this address. */
  customerIdsByEmail(email: string): Promise<string[]>;
}
export interface Clients {
  byUserId(userId: string): Promise<ClientRow | null>;
  pendingSince(isoDate: string): Promise<ClientRow[]>;
  billed(): Promise<ClientRow[]>;
  update(id: string, values: Partial<ClientRow> & { active?: boolean }): Promise<void>;
}

/**
 * Emails about signups and cancellations (to the client and to the admin). A failed email
 * is logged and never fails or undoes the billing step it reports.
 */
export interface Notify {
  signedUp(row: ClientRow, firstCharge: string | null): Promise<void>;
  cancelled(row: ClientRow, accessUntil: string | null, by: 'client' | 'sumit'): Promise<void>;
}
export type Deps = { clients: Clients; sumit: Sumit; productItemId: number; notify?: Notify; log?: (m: string) => void };

async function quietly(deps: Deps, what: string, send: () => Promise<void> | undefined) {
  try {
    await send();
  } catch (e) {
    (deps.log ?? console.error)(`email ${what}: ${e}`);
  }
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
  return [today, paidPeriodEnd(items) ?? today].sort().at(-1)!;
}

/** The end of the period paid for by the ended orders, or null if SUMIT gives no dates. */
function paidPeriodEnd(items: RecurringItem[]): string | null {
  const ends = items
    .filter((item) => ENDED.includes(item.status))
    .map((item) => (item.previousBilling ? addMonth(item.previousBilling) : item.firstBilling))
    .filter((end): end is string => end !== null);
  return ends.sort().at(-1) ?? null;
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
 * paid period does; a later successful payment clears a date the app set. A date the app
 * set after a cancellation only moves to a later paid-period end.
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
    // A date the app set only moves to a later paid-period end (e.g. a grace date, then
    // the user cancels), never to "today" again: paidUntil() is never before today, so
    // recomputing a passed end date would renew it every morning and access would never end.
    if (appOwned) {
      const paidEnd = paidPeriodEnd(items);
      return paidEnd !== null && paidEnd > current.endDate! ? { endDate: paidEnd, sumitEndDate: paidEnd } : null;
    }
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

/**
 * Opens access for a signup awaiting payment once SUMIT shows a paying order for this
 * tool's item. The customer is found by our client id (the payment page's
 * customerexternalidentifier), or by the customer number the admin entered. SUMIT may
 * instead file the payment under an existing customer card (seen in the first real test,
 * 2026-11-18), so as a fallback the customers with the client's verified Google email are
 * checked; the customer number found there is saved, so later checks and cancelling use it.
 */
export async function confirmSignup(row: ClientRow, deps: Deps) {
  if (!row.awaiting_payment) return true;
  const customer = sumitCustomerOf(row) ?? { externalId: externalIdOf(row.id) };
  let items = ofThisProduct(await deps.sumit.list(customer, false), deps.productItemId);
  let foundCustomerId: string | null = null;
  if (billingState(items) !== 'paying' && !row.sumit_customer_id && row.login_email) {
    for (const customerId of await deps.sumit.customerIdsByEmail(row.login_email)) {
      const found = ofThisProduct(await deps.sumit.list({ customerId }, false), deps.productItemId);
      if (billingState(found) === 'paying') {
        items = found;
        foundCustomerId = customerId;
        break;
      }
    }
  }
  if (billingState(items) !== 'paying') return false;
  await deps.clients.update(row.id, {
    awaiting_payment: false, active: true, subscription_end: null, sumit_end_date: null,
    ...(foundCustomerId ? { sumit_customer_id: foundCustomerId } : {}),
  });
  // During the free month SUMIT's first payment date (Date_Start) is the first charge.
  const trial = items.find((item) => item.status === STATUS.PendingForFirstPayment);
  const opened = { ...row, awaiting_payment: false, sumit_customer_id: foundCustomerId ?? row.sumit_customer_id };
  await quietly(deps, `signup ${row.id}`, () => deps.notify?.signedUp(opened, trial?.firstBilling ?? null));
  return true;
}

export type CancelResult = { ok: true; endDate: string | null } | { ok: false; error: string };

/** The client's own cancellation: stops future charges; access runs to the end of the paid period. */
export async function cancelSubscription(row: ClientRow, today: string, deps: Deps): Promise<CancelResult> {
  const customer = sumitCustomerOf(row);
  if (!customer) return { ok: false, error: 'not_billed' };
  if (row.subscription_cancelled_at) return { ok: false, error: 'already_cancelled' };
  const live = ofThisProduct(await deps.sumit.list(customer, false), deps.productItemId).filter((item) => !ENDED.includes(item.status));
  if (live.length === 0) return { ok: false, error: 'no_live_order' };
  for (const item of live) await deps.sumit.cancel(customer, item.id);
  const cancelled = live.map((item) => ({ ...item, status: STATUS.CancelledByCustomer }));
  const next = nextEndDates(currentDates(row), 'cancelled', cancelled, today);
  await deps.clients.update(row.id, { subscription_cancelled_at: new Date().toISOString(), ...(next ? asColumns(next) : {}) });
  const endDate = next ? next.endDate : dateOf(row.subscription_end);
  await quietly(deps, `cancel ${row.id}`, () => deps.notify?.cancelled(row, endDate, 'client'));
  return { ok: true, endDate };
}

export type DailyResult = { opened: number; changed: number; failed: number };

/**
 * Daily: opens recent signups whose payment went through without returning to the tool,
 * then applies nextEndDates to every SUMIT-billed client. Clients the admin manages by
 * hand (no self-signup, no customer number) are never looked at. One client's error is
 * logged and skipped, never applied.
 */
export async function runDaily(today: string, deps: Deps): Promise<DailyResult> {
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
      const state = billingState(items);
      const next = nextEndDates(currentDates(row), state, items, today);
      // Cancelled in SUMIT rather than with the tool's button (which records it itself):
      // recorded once, so the client and the admin are told once and admin shows it.
      const newlyCancelled = state === 'cancelled' && !row.subscription_cancelled_at;
      if (!next && !newlyCancelled) continue;
      await deps.clients.update(row.id, {
        ...(next ? asColumns(next) : {}),
        ...(newlyCancelled ? { subscription_cancelled_at: new Date().toISOString() } : {}),
      });
      result.changed += 1;
      if (newlyCancelled) {
        const accessUntil = next ? next.endDate : dateOf(row.subscription_end);
        await quietly(deps, `cancel ${row.id}`, () => deps.notify?.cancelled(row, accessUntil, 'sumit'));
      }
    } catch (e) {
      result.failed += 1;
      log(`check ${row.id}: ${e}`);
    }
  }
  return result;
}
