import { Router, type Request, type Response } from 'express';
import {
  getUnattestedPayment,
  listUnattestedPayments,
  resolveUnattestedPayment,
  summarizeUnattestedByOperator,
  type UnattestedSource,
  type UnattestedStatus,
} from '../models/unattested-payment.js';
import { runWatcherTick } from '../watchers/solana-watcher.js';
import { runStripeReconcileTick } from '../watchers/stripe-watcher.js';

const router = Router();

function pagination(req: Request): { page: number; limit: number } {
  const page = Math.max(1, parseInt((req.query.page as string) ?? '1', 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt((req.query.limit as string) ?? '50', 10) || 50),
  );
  return { page, limit };
}

function parseStatus(raw: unknown): UnattestedStatus | 'all' | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw).toLowerCase();
  if (value === 'open' || value === 'justified' || value === 'dismissed' || value === 'all') {
    return value;
  }
  return undefined;
}

function parseSource(raw: unknown): UnattestedSource | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw).toLowerCase();
  return value === 'solana' || value === 'stripe' ? value : undefined;
}

router.get('/', async (req: Request, res: Response, next) => {
  try {
    const { page, limit } = pagination(req);
    const operatorId =
      typeof req.query.operator_id === 'string' ? req.query.operator_id : undefined;
    const status = parseStatus(req.query.status);
    const source = parseSource(req.query.source);
    const result = await listUnattestedPayments({
      operatorId,
      status,
      source,
      page,
      limit,
    });
    res.json({
      success: true,
      data: result.records,
      pagination: {
        total: result.total,
        page,
        limit,
        total_pages: Math.max(1, Math.ceil(result.total / limit)),
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/operator/:operatorId/summary', async (req: Request, res: Response, next) => {
  try {
    const operatorId = String(req.params.operatorId ?? '');
    if (!operatorId) {
      res.status(400).json({
        success: false,
        error: 'operatorId is required',
        data: null,
      });
      return;
    }
    const summary = await summarizeUnattestedByOperator(operatorId);
    res.json({ success: true, data: summary, error: null });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const record = await getUnattestedPayment(String(req.params.id ?? ''));
    if (!record) {
      res.status(404).json({
        success: false,
        error: 'Unattested payment not found',
        data: null,
      });
      return;
    }
    res.json({ success: true, data: record, error: null });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/resolve', async (req: Request, res: Response, next) => {
  try {
    const id = String(req.params.id ?? '');
    const body = req.body as {
      status?: 'justified' | 'dismissed';
      resolved_by?: string;
      note?: string;
    };
    if (body.status !== 'justified' && body.status !== 'dismissed') {
      res.status(400).json({
        success: false,
        error: 'status must be either "justified" or "dismissed"',
        data: null,
      });
      return;
    }
    if (!body.resolved_by || typeof body.resolved_by !== 'string') {
      res.status(400).json({
        success: false,
        error: 'resolved_by is required (operator wallet or admin id)',
        data: null,
      });
      return;
    }
    const record = await resolveUnattestedPayment({
      id,
      status: body.status,
      resolvedBy: body.resolved_by,
      note: body.note ?? null,
    });
    if (!record) {
      res.status(404).json({
        success: false,
        error: 'Unattested payment not found',
        data: null,
      });
      return;
    }
    res.json({ success: true, data: record, error: null });
  } catch (err) {
    next(err);
  }
});

/**
 * Manual reconcile trigger used by the dashboard "Run scan now" action and
 * by smoke tests. Always runs both watchers in sequence and returns the
 * raw summaries; the caller decides whether to surface them.
 */
router.post('/reconcile', async (_req: Request, res: Response, next) => {
  try {
    const solana = await runWatcherTick();
    const stripe = await runStripeReconcileTick();
    res.json({
      success: true,
      data: { solana, stripe },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
