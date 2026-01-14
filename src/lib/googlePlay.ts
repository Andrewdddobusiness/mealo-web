import { createSign } from 'crypto';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const GOOGLE_PUBLISHER_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

type ServiceAccount = {
  clientEmail: string;
  privateKey: string;
};

export class GooglePlayValidationError extends Error {
  status: number;
  retryable: boolean;

  constructor(status: number, message: string, opts?: { retryable?: boolean }) {
    super(message);
    this.name = 'GooglePlayValidationError';
    this.status = status;
    this.retryable = Boolean(opts?.retryable);
  }
}

function base64url(input: string | Buffer): string {
  const base64 = Buffer.from(input).toString('base64');
  return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function normalizePrivateKey(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

function getServiceAccount(): ServiceAccount | null {
  const json = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const clientEmail =
        typeof parsed?.client_email === 'string' ? parsed.client_email.trim() : '';
      const privateKey =
        typeof parsed?.private_key === 'string'
          ? normalizePrivateKey(parsed.private_key.trim())
          : '';
      if (!clientEmail || !privateKey) return null;
      return { clientEmail, privateKey };
    } catch {
      return null;
    }
  }

  const clientEmail = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL?.trim() ?? '';
  const privateKeyRaw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY?.trim() ?? '';
  const privateKey = normalizePrivateKey(privateKeyRaw);
  if (!clientEmail || !privateKey) return null;
  return { clientEmail, privateKey };
}

let tokenCache: { accessToken: string; expiresAtMs: number } | null = null;

async function getAccessToken(): Promise<string> {
  const nowMs = Date.now();
  if (tokenCache && tokenCache.expiresAtMs - 60_000 > nowMs) {
    return tokenCache.accessToken;
  }

  const serviceAccount = getServiceAccount();
  if (!serviceAccount) {
    throw new GooglePlayValidationError(
      500,
      'Server misconfigured: Google Play service account not set.',
    );
  }

  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 60 * 60;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: serviceAccount.clientEmail,
      scope: GOOGLE_ANDROID_PUBLISHER_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat,
      exp,
    }),
  );

  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(serviceAccount.privateKey);
  const assertion = `${unsigned}.${base64url(signature)}`;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!res.ok) {
    throw new GooglePlayValidationError(
      500,
      'Server misconfigured: Google Play auth failed.',
    );
  }

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const accessToken = typeof json?.access_token === 'string' ? json.access_token : '';
  const expiresIn =
    typeof json?.expires_in === 'number' ? json.expires_in : Number(json?.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new GooglePlayValidationError(
      500,
      'Server misconfigured: Google Play auth returned an invalid token.',
    );
  }

  tokenCache = { accessToken, expiresAtMs: nowMs + expiresIn * 1000 };
  return accessToken;
}

export type GooglePlaySubscriptionStatus = {
  currentPeriodStart: Date | null;
  expiresAt: Date;
  isTrial: boolean;
  isActive: boolean;
  autoRenewStatus: boolean;
};

export async function validateGooglePlaySubscription(opts: {
  packageName: string;
  subscriptionId: string;
  purchaseToken: string;
}): Promise<GooglePlaySubscriptionStatus> {
  const accessToken = await getAccessToken();
  const url = `${GOOGLE_PUBLISHER_BASE}/applications/${encodeURIComponent(
    opts.packageName,
  )}/purchases/subscriptions/${encodeURIComponent(opts.subscriptionId)}/tokens/${encodeURIComponent(
    opts.purchaseToken,
  )}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw new GooglePlayValidationError(400, 'Invalid purchase token.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new GooglePlayValidationError(
        500,
        'Server misconfigured: Google Play validation not authorized.',
      );
    }
    if (res.status === 429 || res.status >= 500) {
      throw new GooglePlayValidationError(
        503,
        'Google Play validation temporarily unavailable. Please try again.',
        { retryable: true },
      );
    }
    throw new GooglePlayValidationError(502, 'Google Play validation failed.', {
      retryable: true,
    });
  }

  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const expiryTimeMillisRaw = json?.expiryTimeMillis;
  const expiryMs =
    typeof expiryTimeMillisRaw === 'string' || typeof expiryTimeMillisRaw === 'number'
      ? Number(expiryTimeMillisRaw)
      : NaN;
  if (!Number.isFinite(expiryMs) || expiryMs <= 0) {
    throw new GooglePlayValidationError(
      502,
      'Google Play validation returned an invalid expiry time.',
      { retryable: true },
    );
  }

  const expiresAt = new Date(expiryMs);

  const startTimeMillisRaw = json?.startTimeMillis;
  const startMs =
    typeof startTimeMillisRaw === 'string' || typeof startTimeMillisRaw === 'number'
      ? Number(startTimeMillisRaw)
      : NaN;
  const currentPeriodStart = Number.isFinite(startMs) && startMs > 0 ? new Date(startMs) : null;

  const paymentStateRaw = json?.paymentState;
  const paymentState =
    typeof paymentStateRaw === 'number' || typeof paymentStateRaw === 'string'
      ? Number(paymentStateRaw)
      : NaN;
  const hasPaymentState = Number.isFinite(paymentState);
  const isTrial = hasPaymentState ? paymentState === 2 : false;

  const now = new Date();
  const isActive = expiresAt > now && (!hasPaymentState || paymentState !== 0);

  return {
    currentPeriodStart,
    expiresAt,
    isTrial,
    isActive,
    autoRenewStatus: Boolean(json?.autoRenewing),
  };
}
