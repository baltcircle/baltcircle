import { useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";

/**
 * Геолокация для кнопки «моё местоположение».
 * Собственный watchPosition (кеширует последнюю точку) → клик по кнопке моментально
 * перелетает к ней. Каждый клик генерит новый массив — useEffect(center) в MapLibreMap
 * сработает даже если координаты не изменились.
 */
export function useGeolocation() {
  const toast = useToast();
  const [geoCenter, setGeoCenter] = useState<[number, number] | null>(null);
  const lastPosRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => { lastPosRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
      () => { /* silent — ошибку покажем только когда юзер попробует геолокацию */ },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const handleGeolocate = () => {
    // Есть свежая точка — летим мгновенно. Новый массив каждый клик → useEffect тригерится.
    if (lastPosRef.current) {
      setGeoCenter([lastPosRef.current.lat, lastPosRef.current.lng]);
      return;
    }
    // Фоллбэк — точки ещё нет, запрашиваем явно (может вызвать prompt на iOS PWA).
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lastPosRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setGeoCenter([pos.coords.latitude, pos.coords.longitude]);
      },
      () => {
        toast.toast({
          title: "Геолокация недоступна",
          description: "Разрешите доступ к местоположению в настройках браузера",
          variant: "destructive",
        });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  return { geoCenter, lastPosRef, handleGeolocate };
}
