import "@/lib/db/cleanup";
import "@/app/globals.css";
import "@/components/fluent/tiles.css";
import type { Metadata, Viewport } from "next";
import SpriteCloudProvider from "@/components/fluent/SpriteCloudProvider";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0a0e1a",
};

export const metadata: Metadata = {
  title: "Sprite Cloud",
  description: "Retro game library and browser-based streaming",
  appleWebApp: {
    capable: true,
    title: "Sprite Cloud",
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
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(function(regs){regs.forEach(function(r){r.unregister()})})}`,
          }}
        />
      </head>
      <body>
        <SpriteCloudProvider>
          {children}
        </SpriteCloudProvider>
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
