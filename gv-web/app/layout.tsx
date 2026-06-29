import "@/lib/db/cleanup";
import "@/app/globals.css";
import type { Metadata, Viewport } from "next";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#1a1410",
};

export const metadata: Metadata = {
  title: "Sprite Cloud",
  description: "Retro game library and browser-based streaming",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Vault",
    statusBarStyle: "black-translucent",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js').catch(function(e) {
                    console.log('[gv] sw registration skipped:', e.message);
                  });
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
