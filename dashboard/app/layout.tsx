export const metadata = { title: 'Cursorbot Control' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', maxWidth: 720, margin: '0 auto', padding: 24 }}>{children}</body>
    </html>
  );
}
