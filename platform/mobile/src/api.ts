/* Veyora API client.

   The web storefront authenticates with same-origin cookies. A native app has
   no such cookie jar, so this client uses the token pair handed out by
   /auth/mobile/login and sends it as `Authorization: Bearer`, which the API's
   requireAuth already understands.

   Access tokens live 30 minutes. Rather than track expiry, we let a request
   fail with 401 once, refresh, and replay it — concurrent 401s share a single
   refresh via `refreshInFlight` so a screen firing five requests at once
   doesn't burn five refresh tokens (the server rotates on every use, so a
   stampede would invalidate the pair). */

import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

const ACCESS_KEY = 'veyora.accessToken';
const REFRESH_KEY = 'veyora.refreshToken';

export const BASE_URL: string =
  (Constants.expoConfig?.extra as any)?.apiBaseUrl ?? 'https://veyora.design';

const API_URL = `${BASE_URL}/api`;

export class ApiError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data?: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let accessToken: string | null = null;
let refreshToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

/** Called when the refresh token is rejected — the session is unrecoverable
    and the UI needs to send the user back to the login screen. */
let onSessionLost: (() => void) | null = null;
export function setOnSessionLost(fn: (() => void) | null) {
  onSessionLost = fn;
}

export async function loadStoredTokens(): Promise<boolean> {
  [accessToken, refreshToken] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_KEY),
    SecureStore.getItemAsync(REFRESH_KEY),
  ]);
  return !!refreshToken;
}

async function storeTokens(access: string | null, refresh: string | null) {
  accessToken = access;
  refreshToken = refresh;
  await Promise.all([
    access ? SecureStore.setItemAsync(ACCESS_KEY, access) : SecureStore.deleteItemAsync(ACCESS_KEY),
    refresh ? SecureStore.setItemAsync(REFRESH_KEY, refresh) : SecureStore.deleteItemAsync(REFRESH_KEY),
  ]);
}

export function hasSession() {
  return !!refreshToken;
}

/** Raw fetch against the API with no auth handling — used by login/refresh,
    which either have no token yet or are the thing minting one. */
async function rawRequest(method: string, path: string, body?: any): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(API_URL + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    throw new ApiError(data?.message || data?.error || `HTTP ${res.status}`, res.status, data);
  }
  return data;
}

/** Swap the refresh token for a new pair. Returns false when the session is
    dead (token revoked, expired, or the account was disabled). */
async function refreshSession(): Promise<boolean> {
  if (!refreshToken) return false;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const prev = refreshToken;
      accessToken = null; // don't send a known-stale token on the refresh call
      const data = await rawRequest('POST', '/auth/mobile/refresh', { refreshToken: prev });
      await storeTokens(data.accessToken, data.refreshToken);
      return true;
    } catch {
      await storeTokens(null, null);
      onSessionLost?.();
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function request(method: string, path: string, body?: any): Promise<any> {
  try {
    return await rawRequest(method, path, body);
  } catch (err) {
    const unauthorized = err instanceof ApiError && err.status === 401;
    if (!unauthorized || !refreshToken) throw err;
    if (!(await refreshSession())) throw err;
    return rawRequest(method, path, body);
  }
}

export const api = {
  get: (path: string) => request('GET', path),
  post: (path: string, body?: any) => request('POST', path, body),
  del: (path: string) => request('DELETE', path),
};

/* ---------------------------------------------------------------- types --
   Mirrors of the server's response shapes (routes/catalog.js, cart.js,
   orders.js, account.js). Only the fields the app actually reads. */

export type User = {
  id: string;
  customerNumber: number | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  business: string | null;
  country: string | null;
  role: string;
  hidePrices: boolean;
  paymentTerms: string | null;
  balance: number | null;
  // Present on the login response but not on /user/get-user-detail.
  status?: string;
  currency?: string | null;
};

export type Variation = {
  sku: string;
  color: string | null;
  image: string | null;
  qty: number;
  stockStatus: string | null;
  price: number | null;
};

export type Product = {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  size: string | null;
  description: string | null;
  categories: string[];
  tags: string[] | null;
  images: string[] | null;
  attributes: Record<string, any> | null;
  price: number | null;
  basePrice: number | null;
  onSale: boolean;
  qty: number;
  sellable: boolean;
  variations: Variation[];
  isFavourite?: boolean;
  createdAt: string;
};

export type CartItem = {
  id: string;
  sku: string;
  qty: number;
  note: string | null;
  name: string | null;
  color: string | null;
  brand: string | null;
  image: string | null;
  modelSku: string | null;
  productId: string | null;
  available: number;
  stockStatus: string | null;
  price: number | null;
  lineTotal: number | null;
  missing: boolean;
};

export type CartSummary = {
  items: CartItem[];
  subtotal: number;
  totalQty: number;
  promotion: any;
  total: number;
};

export type Order = {
  id: string;
  number: string;
  status: string;
  /** Business order date; `createdAt` is the row timestamp. Migrated orders
      carry their original date, so prefer `date` for display. */
  date: string | null;
  createdAt: string;
  total: number | null;
  shipping: number | null;
  discount: number | null;
  tracking: string | null;
  comments: string | null;
  itemCount?: number;
  currency?: string;
  items?: OrderItem[];
};

export type OrderItem = {
  id: string;
  sku: string;
  name?: string | null;
  color?: string | null;
  qty: number;
  collected?: number;
  price?: number | null;
  note?: string | null;
};

/* ------------------------------------------------------------- endpoints */

export const auth = {
  login: (email: string, password: string) =>
    rawRequest('POST', '/auth/mobile/login', { email, password }) as Promise<{
      user: User;
      accessToken: string;
      refreshToken: string;
    }>,
  logout: async () => {
    const token = refreshToken;
    await storeTokens(null, null);
    if (token) {
      // Best effort — the local session is already gone either way.
      await rawRequest('POST', '/auth/mobile/logout', { refreshToken: token }).catch(() => {});
    }
  },
  requestActivationOtp: (email: string) =>
    rawRequest('POST', '/auth/request-activation-otp', { email }),
  forgotPassword: (email: string) => rawRequest('POST', '/auth/forgot-password', { email }),
  saveTokens: storeTokens,
};

export const catalog = {
  // Param names match routes/catalog.js getProducts exactly — note `isNew` and
  // `sale`, not the more obvious newOnly/saleOnly.
  products: (params: {
    page?: number;
    perPage?: number;
    search?: string;
    brands?: string[];
    sizes?: string[];
    sort?: string;
    isNew?: boolean;
    sale?: boolean;
    inStockOnly?: boolean;
  }) =>
    api.post('/user/get-products', params) as Promise<{
      products: Product[];
      total: number | null;
      hasMore: boolean;
      page: number;
      perPage: number;
    }>,
  product: (id: string) =>
    api.get(`/user/product/${encodeURIComponent(id)}`) as Promise<{ product: Product }>,
  filterData: () =>
    api.get('/user/product-filter-data') as Promise<{
      brands: string[];
      categories: string[];
      priceRange?: { min: number; max: number };
    }>,
};

export const cart = {
  get: () => api.get('/user/get-cart') as Promise<CartSummary>,
  add: (sku: string, qty: number) =>
    api.post('/user/add-to-cart', { sku, qty }) as Promise<CartSummary>,
  remove: (sku: string) =>
    api.post('/user/delete-cart-item', { sku }) as Promise<CartSummary>,
  placeOrder: (body: any = {}) => api.post('/user/place-order', body),
};

export const orders = {
  list: (page = 1, perPage = 20) =>
    api.get(`/user/get-user-orders?page=${page}&perPage=${perPage}`) as Promise<{
      orders: Order[];
      total: number;
    }>,
  detail: (id: string) => api.get(`/user/get-order-detail/${id}`) as Promise<{ order: Order }>,
};

export const account = {
  detail: () => api.get('/user/get-user-detail'),
  replenishment: () => api.get('/user/replenishment'),
  favourites: () => api.get('/user/favourites'),
};

/* Native version gate — see platform/server/api/src/routes/app.js. Public, so
   it works before login and even when the stored session is broken. */
export type AppConfig = {
  platform: string;
  minBuild: number;
  latestBuild: number | null;
  installUrl: string | null;
  message: string | null;
  updateRequired: boolean;
  updateAvailable: boolean;
};

export function fetchAppConfig(platform: string, build: number | null) {
  const qs = `platform=${encodeURIComponent(platform)}${build == null ? '' : `&build=${build}`}`;
  return rawRequest('GET', `/app/config?${qs}`) as Promise<AppConfig>;
}

/** Images are stored as server-absolute paths ("/s3/products/x.jpg"); the web
    storefront uses them as-is because it's same-origin. The app has to make
    them absolute. */
export function imageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:/i.test(path)) return path;
  return BASE_URL + (path.startsWith('/') ? path : `/${path}`);
}
