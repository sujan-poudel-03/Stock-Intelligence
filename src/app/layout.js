import './globals.css';

export const metadata = {
  title: 'NEPSE Intelligence V2',
  description: 'Autonomous NEPSE trading agent',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
