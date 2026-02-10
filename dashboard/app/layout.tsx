import { Inter, Barlow_Condensed } from 'next/font/google';

const inter = Inter({ subsets: ['latin'] });
const barlowCondensed = Barlow_Condensed({ subsets: ['latin'], weight: '600', variable: '--font-din-condensed' });

export const metadata = { title: 'Cursorbot Control' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.className} ${barlowCondensed.variable}`}>
      <body
        style={{
          backgroundColor: '#FDF5E6',
          color: '#1a1a1a',
          minHeight: '100vh',
          maxWidth: 720,
          margin: '0 auto',
          padding: 24,
        }}
      >
        {children}
      </body>
    </html>
  );
}
