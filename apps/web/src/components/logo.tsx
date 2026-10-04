// Square işareti: yuvarlatılmış kare içinde kare boşluk (Arc Square'in işaretinden referans, yeniden çizildi).
export function LogoMark({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={className} fill="currentColor">
      <path
        fillRule="evenodd"
        d="M7 2h18a5 5 0 0 1 5 5v18a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Zm4.5 9.5v9h9v-9h-9Z"
      />
    </svg>
  );
}
