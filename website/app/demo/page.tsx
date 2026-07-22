import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Interactive demo — OnRecord',
  description:
    'Review a synthetic incident, inspect its evidence, revise the draft, and approve a safe simulated record.',
};

export default function DemoPage() {
  return (
    <main>
      <meta httpEquiv="refresh" content="0;url=/review-demo/demo.html" />
      <p>
        Opening the OnRecord demo. If you are not redirected,{' '}
        <a href="/review-demo/demo.html">continue to the review interface</a>.
      </p>
    </main>
  );
}
