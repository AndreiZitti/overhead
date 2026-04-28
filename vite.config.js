// Local dev only: proxy /api/flights → OpenSky directly so the same code path
// works in `vite dev` and on Vercel (where /api/flights.js handles it).

export default {
  server: {
    proxy: {
      '/api/flights': {
        target: 'https://opensky-network.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/flights/, '/api/states/all'),
      },
    },
  },
};
