import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IncidentReviewApplication, StartupFailure } from './app.js';
import {
  ApiError,
  completeAuthorizationCallback,
  loadConfiguration,
} from './auth.js';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status < 500) && failureCount < 1,
      staleTime: 15_000,
    },
    mutations: { retry: false },
  },
});

async function bootstrap(): Promise<void> {
  const rootElement = document.getElementById('app');
  if (rootElement === null) {
    throw new Error('Required application root was not found');
  }
  const root = createRoot(rootElement);
  try {
    const configuration = loadConfiguration();
    await completeAuthorizationCallback(configuration);
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <IncidentReviewApplication configuration={configuration} />
        </QueryClientProvider>
      </StrictMode>,
    );
  } catch {
    root.render(<StartupFailure />);
  }
}

void bootstrap();
