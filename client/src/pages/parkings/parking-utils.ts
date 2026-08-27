export const ADMIN_PARKINGS_KEY = ["/api/admin/parkings"] as const;

// Статус больше не редактируется и не отображается в UI — единственный видимый
// переключатель списка — архив/живые, как у велосипедов.

export type ParkingFormState = {
  id: string;
  name: string;
  city: string;
  capacity: string;
  occupied: string;
  radius: string;
  notes: string;
  // Stored in abstract map space (x = lng field, y = lat field).
  x: number;
  y: number;
};

export const emptyParkingForm: ParkingFormState = {
  id: "", name: "", city: "", capacity: "10", occupied: "0", radius: "30",
  notes: "", x: 500, y: 350,
};
