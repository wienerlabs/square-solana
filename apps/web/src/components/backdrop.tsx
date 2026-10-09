// Sayfanın arkasındaki süs katmanı: ince ızgara ve yavaşça kayan üç renk ışığı (globals.css `.sq-backdrop`).
// Yalnızca görseldir; yardımcı teknolojilere görünmez, tıklamaları engellemez.
export function Backdrop() {
  return (
    <div aria-hidden="true" className="sq-backdrop">
      <div className="sq-glow sq-glow-a" />
      <div className="sq-glow sq-glow-b" />
      <div className="sq-glow sq-glow-c" />
    </div>
  );
}
