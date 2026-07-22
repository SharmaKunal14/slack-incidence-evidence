import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DemoReviewApplication } from './app.js';
import {
  createDemoReviewApi,
  demoConfiguration,
  demoIncidentId,
} from './demo-review-api.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity },
    mutations: { retry: false },
  },
});

const rootElement = document.getElementById('app');
if (rootElement === null) {
  throw new Error('Required application root was not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DemoReviewApplication
        apiClient={createDemoReviewApi()}
        configuration={demoConfiguration}
        incidentId={demoIncidentId}
      />
    </QueryClientProvider>
  </StrictMode>,
);
