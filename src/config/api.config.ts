/**
 * API Configuration
 * Central location for API endpoint configuration
 * Uses environment variable if available, falls back to sensible default
 */

export const API_CONFIG = {
  // Base URL for backend API calls
  BASE_URL: (() => {
    const fromEnv = (process.env.REACT_APP_API_URL || '').trim();
    const nodeEnv = process.env.NODE_ENV;

    if (fromEnv) {
      const normalized = fromEnv.replace(/\/$/, '');

      if (/^https?:\/\//i.test(normalized)) {
        try {
          const url = new URL(normalized);
          const pathname = url.pathname && url.pathname !== '/' ? url.pathname : '';
          const hasApiSuffix = pathname.endsWith('/api');
          const normalizedPath = hasApiSuffix ? pathname : `${pathname}/api`;
          return `${url.origin}${normalizedPath}`;
        } catch {
          return normalized;
        }
      }

      return normalized;
    }

    // In production, prefer the direct Render backend URL when available.
    // If you still want to use Vercel's /api proxy, set REACT_APP_API_URL to /api and rebuild.
    if (nodeEnv !== 'development') {
      return 'https://activecore.onrender.com/api';
    }

    // Development fallback only.
    return 'http://localhost:3002/api';
  })(),
};

export default API_CONFIG;
