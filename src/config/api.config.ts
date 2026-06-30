/**
 * API Configuration
 * Central location for API endpoint configuration
 * Uses environment variable if available, falls back to sensible default
 */

export const API_CONFIG = {
  // Base URL for backend API calls
  BASE_URL: (() => {
    const fromEnv = (process.env.REACT_APP_API_URL || '').trim();
    if (fromEnv) {
      const normalized = fromEnv.replace(/\/$/, '');

      if (/^https?:\/\//i.test(normalized)) {
        try {
          const url = new URL(normalized);
          const pathname = url.pathname && url.pathname !== '/' ? url.pathname : '/api';
          const withApiSuffix = pathname.endsWith('/api') ? pathname : `${pathname}/api`;
          return `${url.origin}${withApiSuffix}`;
        } catch {
          return normalized;
        }
      }

      return normalized;
    }

    const nodeEnv = process.env.NODE_ENV;

    // In production (and generally any non-dev environment), never fall back to localhost.
    // Use same-origin /api so Vercel (or any reverse proxy) can forward requests.
    if (nodeEnv !== 'development') {
      console.warn(
        '[API_CONFIG] REACT_APP_API_URL is not set. Falling back to same-origin /api. '
          + 'If your backend is on a different domain, set REACT_APP_API_URL and rebuild/redeploy.'
      );
      return '/api';
    }

    // Development fallback only.
    return 'http://localhost:3002/api';
  })(),
};

export default API_CONFIG;
