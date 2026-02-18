export const metadata = { title: 'Cursorbot Control' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ fontFamily: 'Inter, Barlow Condensed, system-ui, sans-serif' }}>
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
