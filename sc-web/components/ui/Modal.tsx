"use client";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** If true, clicking backdrop closes modal (default: true) */
  backdropClose?: boolean;
  width?: number;
}

export default function Modal({
  open,
  onClose,
  title,
  children,
  backdropClose = true,
  width = 400,
}: ModalProps) {
  if (!open) return null;

  return (
    <>
      <div
        onClick={backdropClose ? onClose : undefined}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.65)",
          zIndex: 90,
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "var(--color-surface-default)",
          border: "1px solid var(--color-border-default)",
          borderRadius: "2px",
          padding: "var(--space-7) var(--space-8)",
          zIndex: 95,
          minWidth: 320,
          maxWidth: width,
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        {title && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "var(--space-6)",
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: "var(--font-size-lg)",
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-primary)",
              }}
            >
              {title}
            </h3>
            <button
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                color: "var(--color-text-secondary)",
                cursor: "pointer",
                fontSize: "var(--font-size-lg)",
                fontFamily: "var(--font-mono)",
                padding: 0,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        )}
        {children}
      </div>
    </>
  );
}
