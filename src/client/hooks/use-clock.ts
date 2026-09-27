import { useEffect, useState } from "react";

/** Обновляет время ожидания агента раз в секунду и освобождает таймер при закрытии экрана. */
export function useClock(): number {
  const [now, setNow] = useState(Date.now());
  // Таймер меняет только отображаемую длительность, не состояние серверной задачи.
  useEffect(() => {
    // Обновляет текущее время для счётчика ожидания.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    // Останавливает счётчик после удаления компонента.
    return () => clearInterval(timer);
  }, []);
  return now;
}
