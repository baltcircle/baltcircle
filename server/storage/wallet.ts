import { wallet, payments, walletTopupOrders } from "@shared/schema";
import type { Wallet, Payment, WalletTopupOrder } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { db, pool } from "../db/bootstrap";
import type { Constructor } from "./mixin";
import type { IWalletStorage } from "./interfaces";

export function WalletMixin<TBase extends Constructor>(Base: TBase) {
  return class extends Base implements IWalletStorage {
    async getWallet(userId: string) {
      let w = (await db.select().from(wallet).where(eq(wallet.userId, userId)).limit(1))[0] as Wallet | undefined;
      if (!w) {
        await db.insert(wallet).values({ userId, balance: 0, activeTariff: "payg", tariffExpiresAt: null } as any);
        w = (await db.select().from(wallet).where(eq(wallet.userId, userId)).limit(1))[0] as Wallet;
      }
      return w;
    }

    // Top up the wallet inside a single DB transaction. The balance change is an
    // atomic SQL increment (`balance = balance + $amount`) via an UPSERT, not a
    // read-then-write in app code, so two concurrent top-ups can never lose an
    // update (audit M2). The payment row is written in the same transaction so a
    // balance change and its ledger entry always land together.
    async topUp(userId: string, amount: number) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const w = (await client.query(
          `INSERT INTO wallet (user_id, balance, active_tariff, tariff_expires_at)
           VALUES ($1, $2, 'payg', NULL)
           ON CONFLICT (user_id) DO UPDATE SET balance = wallet.balance + $2
           RETURNING user_id AS "userId", balance,
                     active_tariff AS "activeTariff", tariff_expires_at AS "tariffExpiresAt"`,
          [userId, amount],
        )).rows[0] as Wallet;
        const pay = (await client.query(
          `INSERT INTO payments (user_id, amount, kind, description, created_at)
           VALUES ($1, $2, 'topup', $3, $4)
           RETURNING id, user_id AS "userId", amount, kind, description, created_at AS "createdAt"`,
          [userId, amount, `Пополнение баланса карты •• 4242`, Date.now()],
        )).rows[0] as Payment;
        await client.query("COMMIT");
        return { wallet: w, payment: pay };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    // Purchase a tariff inside a single transaction. The debit is a conditional
    // atomic update (`balance = balance - $price WHERE balance >= $price`): if a
    // concurrent purchase already drained the wallet the update matches no row and
    // we reject, so the balance can never go negative or be double-spent (M2).
    //
    // Audit MEDIUM: idempotencyKey, when supplied, gates the WHOLE purchase
    // (debit + payment row) so a retried request (double-click, network drop +
    // resend) replays the original result instead of debiting twice. The
    // payment row is inserted FIRST with `ON CONFLICT (user_id, idempotency_key)
    // DO NOTHING` — the partial unique index is the actual guarantee, this is
    // just the mechanism. If we lose that race (0 rows), the winning request
    // already committed, so we roll back our own attempt (no debit happened on
    // our side) and replay ITS committed payment row + the current wallet. If
    // we win the race but the debit then fails for insufficient funds, we roll
    // back EVERYTHING including our own payment row — a failed attempt must
    // not permanently burn the key, so a retry after topping up can still
    // succeed with the same key.
    async purchaseTariff(userId: string, tariff: string, price: number, durationMs: number, idempotencyKey?: string) {
      const expires = Date.now() + durationMs;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        let pay: Payment;
        if (idempotencyKey) {
          const insRows = (await client.query(
            `INSERT INTO payments (user_id, amount, kind, description, created_at, idempotency_key)
             VALUES ($1, $2, 'tariff_purchase', $3, $4, $5)
             ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
             RETURNING id, user_id AS "userId", amount, kind, description, created_at AS "createdAt", idempotency_key AS "idempotencyKey"`,
            [userId, -price, `Подключён тариф «${tariff}»`, Date.now(), idempotencyKey],
          )).rows;

          if (insRows.length === 0) {
            await client.query("ROLLBACK");
            const existing = (await pool.query(
              `SELECT id, user_id AS "userId", amount, kind, description, created_at AS "createdAt", idempotency_key AS "idempotencyKey"
               FROM payments WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1`,
              [userId, idempotencyKey],
            )).rows[0] as Payment | undefined;
            if (!existing) {
              // The conflicting insert can only be invisible to us here if it was
              // rolled back — in which case Postgres would not have reported a
              // conflict at all. Treat this as an unexpected infra error.
              throw new Error("Не удалось обработать запрос повторно — попробуйте ещё раз");
            }
            const w = (await pool.query(
              `SELECT user_id AS "userId", balance, active_tariff AS "activeTariff", tariff_expires_at AS "tariffExpiresAt" FROM wallet WHERE user_id = $1`,
              [userId],
            )).rows[0] as Wallet;
            return { wallet: w, payment: existing };
          }
          pay = insRows[0] as Payment;
        }

        const rows = (await client.query(
          `UPDATE wallet SET balance = balance - $2, active_tariff = $3, tariff_expires_at = $4
           WHERE user_id = $1 AND balance >= $2
           RETURNING user_id AS "userId", balance,
                     active_tariff AS "activeTariff", tariff_expires_at AS "tariffExpiresAt"`,
          [userId, price, tariff, expires],
        )).rows;
        if (rows.length === 0) {
          // Insufficient funds: roll back the debit AND (if present) the payment
          // row inserted above, so a retry with the same key isn't permanently
          // stuck on this failed attempt.
          await client.query("ROLLBACK");
          throw new Error("Недостаточно средств на балансе");
        }
        const w = rows[0] as Wallet;

        if (!idempotencyKey) {
          pay = (await client.query(
            `INSERT INTO payments (user_id, amount, kind, description, created_at)
             VALUES ($1, $2, 'tariff_purchase', $3, $4)
             RETURNING id, user_id AS "userId", amount, kind, description, created_at AS "createdAt"`,
            [userId, -price, `Подключён тариф «${tariff}»`, Date.now()],
          )).rows[0] as Payment;
        }

        await client.query("COMMIT");
        return { wallet: w, payment: pay! };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    async listPayments(userId: string) {
      return (await db.select().from(payments)
        .where(eq(payments.userId, userId))
        .orderBy(desc(payments.createdAt))) as Payment[];
    }

    // ---------- T-Bank wallet top-up orders (audit CRITICAL #1 fix) ----------
    // Create a pending top-up order when the rider starts the pay-then-credit
    // flow. The wallet balance is NOT touched here — only the confirmed
    // notification webhook (handleWalletTopupNotification) ever calls topUp().
    async createWalletTopupOrder(input: { orderId: string; userId: string; amountKopecks: number }) {
      const now = Date.now();
      return (await db.insert(walletTopupOrders).values({
        orderId: input.orderId,
        userId: input.userId,
        amountKopecks: input.amountKopecks,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      } as any).returning())[0] as WalletTopupOrder;
    }

    async getWalletTopupOrder(orderId: string) {
      return (await db.select().from(walletTopupOrders)
        .where(eq(walletTopupOrders.orderId, orderId))
        .limit(1))[0] as WalletTopupOrder | undefined;
    }

    async updateWalletTopupOrder(id: number, patch: Partial<WalletTopupOrder>) {
      const set: Record<string, unknown> = { ...patch, updatedAt: Date.now() };
      delete set.id;
      await db.update(walletTopupOrders).set(set as any).where(eq(walletTopupOrders.id, id));
      return (await db.select().from(walletTopupOrders).where(eq(walletTopupOrders.id, id)).limit(1))[0] as
        | WalletTopupOrder
        | undefined;
    }
  };
}
