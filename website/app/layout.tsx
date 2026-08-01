import type { Metadata } from 'next';
import './globals.css';

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  'https://onrecord-evidence.kvsharma-ks-14.chatgpt.site';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'OnRecord — Put every incident on the record',
  description:
    'Turn messy Slack incident conversations into an evidence-linked record reviewed and approved by a human.',
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
  },
  openGraph: {
    title: 'OnRecord — Put every incident on the record',
    description:
      'Turn messy Slack incident conversations into an evidence-linked record reviewed and approved by a human.',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1792,
        height: 933,
        alt: 'OnRecord evidence fragments converging into a reviewed incident record',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'OnRecord — Put every incident on the record',
    description:
      'Turn messy Slack incident conversations into an evidence-linked record reviewed and approved by a human.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
