// Square işareti: üst üste binen iki yuvarlatılmış kare; kesiştikleri alan boş kalır (evenodd).
export function LogoMark({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className} fill="currentColor">
      <path
        fillRule="evenodd"
        d="M3.3 2h18.4a1.3 1.3 0 0 1 1.3 1.3v18.4a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 21.7V3.3A1.3 1.3 0 0 1 3.3 2ZM10.3 9h18.4a1.3 1.3 0 0 1 1.3 1.3v18.4a1.3 1.3 0 0 1-1.3 1.3H10.3A1.3 1.3 0 0 1 9 28.7V10.3A1.3 1.3 0 0 1 10.3 9Z"
      />
    </svg>
  );
}
