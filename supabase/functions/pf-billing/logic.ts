// Billing rules for the allocation tool, ported from MoneySystem (src/server/billing-check.ts)
// so both products treat SUMIT standing orders the same way. Pure functions plus flows that
// take their database and SUMIT access as arguments, so they can be tested without either.
//
// The tool decides who has access, from dates in its own database. SUMIT is only asked what
// was paid (a customer's standing orders: status, first and last charge dates), looked up by
// customer number, email or phone, and asked to cancel an order. Nothing here depends on
// SUMIT's retry policy, webhooks or reactivating orders.

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
/** After access ends, the profile and its data are kept this many days (renewal window), then deleted. */
export const KEEP_DAYS = 60;
/** The "access ended" email is sent only for an end date this recent (never for old clients). */
const ENDED_NOTICE_DAYS = 7;

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

/**
 * A SUMIT customer, always by customer number. Never by external identifier: SUMIT creates
 * an empty customer card when that finds no match (seen in the real tests, 2026-11-19).
 */
export type SumitCustomer = { customerId: string };

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
  active?: boolean | null;
  user_id?: string | null;
  /** Newest charge date seen in SUMIT: a later one means the client paid again. */
  sumit_last_charge?: string | null;
  /** The end date the "access ended" email was sent for. */
  access_end_notice?: string | null;
  /** When the admin was told this client is due for deletion but SUMIT still has a live order. */
  deletion_held_at?: string | null;
  /** The live orders (ids, sorted) the admin was emailed about, so they are told once. */
  orders_notice?: string | null;
};

export interface Sumit {
  list(customer: SumitCustomer, includeInactive: boolean): Promise<RecurringItem[]>;
  cancel(customer: SumitCustomer, recurringItemId: number): Promise<void>;
  /** SUMIT customer numbers whose email is exactly this address (only reads). */
  customerIdsByEmail(email: string): Promise<string[]>;
  /** SUMIT customer numbers whose phone is exactly this number (only reads). */
  customerIdsByPhone(phone: string): Promise<string[]>;
}
export interface Clients {
  byUserId(userId: string): Promise<ClientRow | null>;
  byId(id: string): Promise<ClientRow | null>;
  pendingSince(isoDate: string): Promise<ClientRow[]>;
  billed(): Promise<ClientRow[]>;
  /** Access ended before the cutoff (end date), or a signup never paid, created before it. */
  dueForDeletion(cutoffDate: string): Promise<ClientRow[]>;
  /** Deletes the profile, its allocations and its Google sign-in record. */
  remove(row: ClientRow): Promise<void>;
  update(id: string, values: Partial<ClientRow>): Promise<void>;
}

/**
 * Emails (to the client and to the admin). A failed email is logged and never fails or
 * undoes the billing step it reports.
 */
export interface Notify {
  signedUp(row: ClientRow, firstCharge: string | null): Promise<void>;
  cancelled(row: ClientRow, accessUntil: string | null, by: 'client' | 'sumit'): Promise<void>;
  /** Access ended without a cancellation (failed payment): renew within KEEP_DAYS. */
  ended(row: ClientRow, endDate: string): Promise<void>;
  /** To the admin: due for deletion, but SUMIT still has a live order for this client. */
  held(row: ClientRow, endDate: string): Promise<void>;
  /** To the admin: a client with open access has more than one live order for this tool. */
  duplicateOrders(row: ClientRow, customerId: string, orderIds: number[]): Promise<void>;
}
export type Deps = {
  clients: Clients;
  sumit: Sumit;
  /** This tool's catalog item(s) in SUMIT; the signup and renewal pages may use different items. */
  productItemId: number | number[];
  notify?: Notify;
  log?: (m: string) => void;
};

async function quietly(deps: Deps, what: string, send: () => Promise<void> | undefined) {
  try {
    await send();
  } catch (e) {
    (deps.log ?? console.error)(`${what}: ${e}`);
  }
}

/**
 * The client's SUMIT customer: the number saved when a payment was found, or entered by the
 * admin. Without one the client is managed by hand.
 */
export function sumitCustomerOf(row: Pick<ClientRow, 'sumit_customer_id'>): SumitCustomer | null {
  return row.sumit_customer_id ? { customerId: row.sumit_customer_id } : null;
}

/** Only this tool's catalog item(s) count: the same SUMIT account also bills MoneySystem. */
export function ofThisProduct(items: RecurringItem[], productItemId: number | number[]) {
  const ids = Array.isArray(productItemId) ? productItemId : [productItemId];
  return items.filter((item) => item.itemId !== null && ids.includes(item.itemId));
}

export function billingState(items: RecurringItem[]): BillingState {
  if (items.some((item) => PAYING.includes(item.status))) return 'paying';
  if (items.some((item) => FAILING.includes(item.status))) return 'failing';
  if (items.some((item) => ENDED.includes(item.status))) return 'cancelled';
  return 'unknown';
}

export function addDays(iso: string, days: number) {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
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
export function dateOf(value: string | null | undefined) {
  return value ? value.slice(0, 10) : null;
}

/** The last day the client may renew (and their data is kept): KEEP_DAYS after access ended. */
export function renewUntil(endDate: string) {
  return addDays(endDate, KEEP_DAYS);
}

/** Has access today: switched on, not awaiting payment, end date not passed. */
export function hasAccess(row: Pick<ClientRow, 'active' | 'awaiting_payment' | 'subscription_end'>, today: string) {
  const end = dateOf(row.subscription_end);
  return row.active !== false && !row.awaiting_payment && (end === null || end >= today);
}

type EndDates = { endDate: string | null; sumitEndDate: string | null };

/**
 * An end date the app did not set (the admin's) is never changed here (but see the new-charge
 * rule in checkBilled). With no end date, a failed charge gives PAYMENT_GRACE_DAYS more days;
 * a cancellation ends access when the paid period does; a later successful payment clears a
 * date the app set. A date the app set after a cancellation only moves to a later paid-period end.
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
 * The newest charge SUMIT shows for this tool: an order's last charge date, or the first
 * charge date of a paying order once it is due (an order charged on the renewal page starts
 * today). A free-month order not yet charged has none.
 */
export function lastCharge(items: RecurringItem[], today: string): string | null {
  const dates = items
    .map((item) => item.previousBilling ?? (PAYING.includes(item.status) && item.firstBilling && item.firstBilling <= today ? item.firstBilling : null))
    .filter((d): d is string => d !== null);
  return dates.sort().at(-1) ?? null;
}

/**
 * Opens access for a signup awaiting payment once SUMIT shows a paying order for this
 * tool's item. The customer card is the one the admin entered, or else found by the
 * client's verified Google email and then by their phone (both prefilled on the payment
 * page). These lookups only read: SUMIT may file the payment under a new or an existing
 * card. The customer number found is saved, so later checks and cancelling use it.
 */
export async function confirmSignup(row: ClientRow, deps: Deps) {
  if (!row.awaiting_payment) return true;
  const found = await payingCustomer(row, deps);
  if (!found) return false;
  await deps.clients.update(row.id, {
    awaiting_payment: false, active: true, subscription_end: null, sumit_end_date: null,
    sumit_customer_id: found.customerId,
    ...(lastCharge(found.items, todayUtc()) ? { sumit_last_charge: lastCharge(found.items, todayUtc()) } : {}),
  });
  // During the free month SUMIT's first payment date (Date_Start) is the first charge.
  const trial = found.items.find((item) => item.status === STATUS.PendingForFirstPayment);
  const opened = { ...row, awaiting_payment: false, sumit_customer_id: found.customerId };
  await quietly(deps, `email signup ${row.id}`, () => deps.notify?.signedUp(opened, trial?.firstBilling ?? null));
  return true;
}
const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * A SUMIT card with a paying order for this tool: the saved customer number, or else found
 * by the client's sign-in email and then by their phone. `skip` is a card already checked.
 */
async function payingCustomer(row: ClientRow, deps: Deps, skip?: string): Promise<{ customerId: string; items: RecurringItem[] } | null> {
  const tried = new Set<string>(skip ? [skip] : []);
  const check = async (customerId: string) => {
    if (tried.has(customerId)) return null;
    tried.add(customerId);
    const items = ofThisProduct(await deps.sumit.list({ customerId }, false), deps.productItemId);
    return billingState(items) === 'paying' ? { customerId, items } : null;
  };
  if (row.sumit_customer_id) return check(row.sumit_customer_id);
  const email = (row.login_email || row.email || '').trim();
  const lookups: Array<() => Promise<string[]>> = [];
  if (email) lookups.push(() => deps.sumit.customerIdsByEmail(email));
  if (row.phone) lookups.push(() => deps.sumit.customerIdsByPhone(row.phone!));
  for (const lookup of lookups) {
    for (const customerId of await lookup()) {
      const found = await check(customerId);
      if (found) return found;
    }
  }
  return null;
}

/** Newest first: by first charge date, then by order number. */
function newestFirst(a: RecurringItem, b: RecurringItem) {
  return (b.firstBilling ?? '').localeCompare(a.firstBilling ?? '') || b.id - a.id;
}

/**
 * Brings one client up to date with SUMIT (daily, when the client signs in or presses
 * "כבר שילמתי — בדוק שוב", and from the admin's "בדוק מול SUMIT"):
 *  - A new charge (newer than the last one seen) means the client paid: any end date is
 *    removed, the admin's too, and access opens. So a manual extension never blocks a client
 *    who renews, and renewing on the renewal page opens access at once.
 *  - Otherwise the end-date rules (grace after a failed charge, end of paid period).
 *  - A client without access, or in the grace period, may have paid on another SUMIT card
 *    (the renewal page can file it there): with `lookup`, found by email, then phone.
 *  - When a new payment reopens access (renewal, or fixing a failed payment), the client's
 *    other live orders for this tool are cancelled (the old failing one), so an old card can
 *    never be charged later. In any other case nothing is cancelled: if a client with open
 *    access has more than one live order, the admin is emailed once and decides.
 *  - "Access ended" email once, when access ended without a cancellation.
 * Returns true when something changed.
 */
export async function checkBilled(row: ClientRow, today: string, deps: Deps, lookup: boolean): Promise<boolean> {
  let customer = sumitCustomerOf(row);
  let items = customer ? ofThisProduct(await deps.sumit.list(customer, true), deps.productItemId) : [];
  let state = billingState(items);
  let previousCard: SumitCustomer | null = null;
  if (state !== 'paying' && lookup && (!hasAccess(row, today) || row.subscription_end)) {
    const found = await payingCustomer({ ...row, sumit_customer_id: null }, deps, customer?.customerId);
    if (found) {
      previousCard = customer;
      customer = { customerId: found.customerId };
      items = ofThisProduct(await deps.sumit.list(customer, true), deps.productItemId);
      state = billingState(items);
    }
  }
  if (!customer) return false;

  const values: Partial<ClientRow> = {};
  if (customer.customerId !== row.sumit_customer_id) values.sumit_customer_id = customer.customerId;
  const charged = lastCharge(items, today);
  const seen = dateOf(row.sumit_last_charge);
  if (charged && (!seen || charged > seen)) values.sumit_last_charge = charged;
  // Before the first check there is no last charge on record: a charge after the end date
  // (or on a newly found card) is still a new payment.
  const end = dateOf(row.subscription_end);
  const newCharge = state === 'paying' && charged !== null
    && (previousCard !== null || !row.sumit_customer_id || (seen ? charged > seen : end !== null && charged > end));
  const closed = end !== null || row.active === false || row.subscription_cancelled_at !== null;
  const reopened = newCharge && closed;
  let newlyCancelled = false;
  let next: EndDates | null = null;
  if (reopened) {
    Object.assign(values, {
      subscription_end: null, sumit_end_date: null, active: true, subscription_cancelled_at: null,
      access_end_notice: null, deletion_held_at: null,
    });
  } else {
    next = nextEndDates(currentDates(row), state, items, today);
    if (next) Object.assign(values, asColumns(next));
    // Cancelled in SUMIT rather than with the tool's button (which records it itself):
    // recorded once, so the client and the admin are told once and admin shows it.
    newlyCancelled = state === 'cancelled' && !row.subscription_cancelled_at;
    if (newlyCancelled) values.subscription_cancelled_at = new Date().toISOString();
  }

  // Access ended without a cancellation (a failed payment): tell the client once, recently only.
  const after = { ...row, ...values };
  const endAfter = dateOf(after.subscription_end);
  const endedNotice = endAfter !== null && endAfter < today && endAfter >= addDays(today, -ENDED_NOTICE_DAYS)
    && after.active !== false && !after.subscription_cancelled_at && dateOf(row.access_end_notice) !== endAfter;
  if (endedNotice) values.access_end_notice = endAfter;

  // Other live orders for this tool besides the newest paying one (on this card, and on the
  // card the client paid from before, if a renewal was filed on another one).
  let old: Array<{ card: SumitCustomer; item: RecurringItem }> = [];
  let keep: RecurringItem | undefined;
  if (state === 'paying') {
    keep = items.filter((item) => PAYING.includes(item.status)).sort(newestFirst)[0];
    old = items.filter((item) => item !== keep && !ENDED.includes(item.status)).map((item) => ({ card: customer!, item }));
    if (previousCard) {
      const before = ofThisProduct(await deps.sumit.list(previousCard, false), deps.productItemId).filter((item) => !ENDED.includes(item.status));
      old.push(...before.map((item) => ({ card: previousCard!, item })));
    }
  }
  // Not a renewal: never cancel; tell the admin once per set of orders.
  const ordersKey = !reopened && old.length ? [keep!, ...old.map((o) => o.item)].map((item) => item.id).sort((a, b) => a - b).join(',') : null;
  const ordersNotice = ordersKey !== null && row.orders_notice !== ordersKey;
  if (ordersNotice) values.orders_notice = ordersKey;

  const changed = Object.keys(values).length > 0;
  if (changed) await deps.clients.update(row.id, values);

  if (reopened) {
    for (const { card, item } of old) {
      await quietly(deps, `cancel old order ${row.id}/${item.id}`, () => deps.sumit.cancel(card, item.id));
    }
  }
  if (ordersNotice) {
    await quietly(deps, `email orders ${row.id}`, () => deps.notify?.duplicateOrders(after, customer!.customerId, ordersKey!.split(',').map(Number)));
  }
  if (newlyCancelled) {
    const accessUntil = next ? next.endDate : end;
    await quietly(deps, `email cancel ${row.id}`, () => deps.notify?.cancelled(after, accessUntil, 'sumit'));
  }
  if (endedNotice) await quietly(deps, `email ended ${row.id}`, () => deps.notify?.ended(after, endAfter!));
  return changed;
}

/**
 * When the client opens the tool or presses "כבר שילמתי — בדוק שוב", and from the admin's
 * "בדוק מול SUMIT": a signup awaiting payment is confirmed; anyone else is checked now
 * (looking on other SUMIT cards too), so a payment opens access at once.
 */
export async function checkClient(row: ClientRow, today: string, deps: Deps) {
  if (row.awaiting_payment) return confirmSignup(row, deps);
  await checkBilled(row, today, deps, true);
  return true;
}

export type CancelResult ={ ok: true; endDate: string | null } | { ok: false; error: string };

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
  await quietly(deps, `email cancel ${row.id}`, () => deps.notify?.cancelled(row, endDate, 'client'));
  return { ok: true, endDate };
}

export type EndResult = { ok: true; endedAt: string; cancelledInSumit: number; cancelledAt: string | null };

/**
 * The admin's "סיים מנוי": cancels this tool's live standing orders in SUMIT (for a client with
 * a SUMIT customer number), then ends access now. SUMIT is cancelled first, so if SUMIT fails
 * nothing in the tool changes and the admin can try again (orders already cancelled are
 * skipped). The end date is the admin's (sumit_end_date cleared), so the daily check never
 * changes it. No email: the admin tells the client.
 */
export async function endNow(row: ClientRow, now: string, deps: Deps): Promise<EndResult> {
  const customer = sumitCustomerOf(row);
  let cancelledInSumit = 0;
  if (customer) {
    const live = ofThisProduct(await deps.sumit.list(customer, false), deps.productItemId).filter((item) => !ENDED.includes(item.status));
    for (const item of live) {
      await deps.sumit.cancel(customer, item.id);
      cancelledInSumit += 1;
    }
  }
  const cancelledAt = customer ? (row.subscription_cancelled_at ?? now) : row.subscription_cancelled_at;
  // A client whose access already ended keeps that end date (the 60 days count from it);
  // only the standing order is cancelled then.
  const endedAt = hasAccess(row, now.slice(0, 10)) ? now : (row.subscription_end ?? now);
  await deps.clients.update(row.id, { active: false, subscription_end: endedAt, sumit_end_date: null, subscription_cancelled_at: cancelledAt });
  return { ok: true, endedAt, cancelledInSumit, cancelledAt };
}

export type DailyResult = { opened: number; changed: number; failed: number };

/**
 * Daily: opens recent signups whose payment went through without returning to the tool,
 * then checks every client with a SUMIT customer number (checkBilled; other cards are
 * looked at only for clients without access or in the grace period). Clients the admin
 * manages by hand are checked when they open the tool. One client's error is logged and
 * skipped, never applied.
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
      if (await checkBilled(row, today, deps, true)) result.changed += 1;
    } catch (e) {
      result.failed += 1;
      log(`check ${row.id}: ${e}`);
    }
  }
  return result;
}

export type RetentionResult = { deleted: string[]; held: string[]; due: string[]; failed: number };

/**
 * Daily: deletes clients whose access ended more than KEEP_DAYS ago, and signups never paid
 * created more than KEEP_DAYS ago: profile, allocations and Google sign-in record. A client
 * with access is never deleted. A client SUMIT still has a live order for (or, for an unpaid
 * signup, a paying one) is not deleted; the admin is emailed once instead. Nothing is
 * cancelled here. With `enabled` false only lists who is due (in `due`), deletes nothing.
 */
export async function runRetention(today: string, deps: Deps, enabled: boolean): Promise<RetentionResult> {
  const result: RetentionResult = { deleted: [], held: [], due: [], failed: 0 };
  const cutoff = addDays(today, -KEEP_DAYS);
  for (const row of await deps.clients.dueForDeletion(cutoff)) {
    try {
      // Same rule again here, so a wrong query can never delete someone with access.
      const end = dateOf(row.subscription_end);
      const over = row.awaiting_payment ? dateOf(row.created_at)! < cutoff && (end === null || end < cutoff) : end !== null && end < cutoff;
      if (!over || hasAccess(row, today)) continue;
      let live = false;
      if (row.awaiting_payment) live = (await payingCustomer(row, deps)) !== null;
      else {
        const customer = sumitCustomerOf(row);
        if (customer) live = ofThisProduct(await deps.sumit.list(customer, false), deps.productItemId).some((item) => !ENDED.includes(item.status));
      }
      if (live) {
        result.held.push(row.name);
        if (enabled && !row.deletion_held_at) {
          await deps.clients.update(row.id, { deletion_held_at: new Date().toISOString() });
          await quietly(deps, `email held ${row.id}`, () => deps.notify?.held(row, end ?? dateOf(row.created_at)!));
        }
        continue;
      }
      if (!enabled) {
        result.due.push(row.name);
        continue;
      }
      await deps.clients.remove(row);
      result.deleted.push(row.name);
    } catch (e) {
      result.failed += 1;
      (deps.log ?? console.error)(`retention ${row.id}: ${e}`);
    }
  }
  return result;
}
