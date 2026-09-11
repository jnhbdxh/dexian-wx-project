import { buildDateOptions, totalLabel } from "../../lib/booking-ui";

interface ServiceOption {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
  priceCents: number;
  priceLabel: string;
  mark: string;
  tone: string;
}

interface GuestCountOption {
  count: number;
  enabled: boolean;
}

interface TimeOption {
  value: string;
  label: string;
  available: boolean;
  note: string;
}

interface TherapistOption {
  id: string;
  name: string;
  specialty: string;
  mark: string;
  tone: string;
}

const storeTimezone = "Asia/Shanghai";
const initialDates = buildDateOptions(new Date(), storeTimezone);

const services: ServiceOption[] = [
  {
    id: "calm",
    name: "舒缓放松",
    description: "轻柔舒展，适合久坐与疲惫状态",
    durationMinutes: 60,
    priceCents: 32800,
    priceLabel: "¥328",
    mark: "缓",
    tone: "sage",
  },
  {
    id: "restore",
    name: "深度焕活",
    description: "专注肩颈与腰背，释放紧绷感",
    durationMinutes: 90,
    priceCents: 46800,
    priceLabel: "¥468",
    mark: "松",
    tone: "clay",
  },
  {
    id: "sleep",
    name: "静眠疗愈",
    description: "慢节奏护理，帮助身心安静下来",
    durationMinutes: 120,
    priceCents: 59800,
    priceLabel: "¥598",
    mark: "静",
    tone: "sand",
  },
];

const therapists: TherapistOption[] = [
  {
    id: "xia",
    name: "夏天",
    specialty: "舒缓护理",
    mark: "夏",
    tone: "sage",
  },
  {
    id: "chen",
    name: "晓晨",
    specialty: "肩颈放松",
    mark: "晨",
    tone: "clay",
  },
  {
    id: "ke",
    name: "可可",
    specialty: "静眠疗愈",
    mark: "可",
    tone: "sand",
  },
];

const timeOptions: TimeOption[] = [
  { value: "11:00", label: "11:00", available: true, note: "最快可约" },
  { value: "13:30", label: "13:30", available: true, note: "余 2 位" },
  { value: "14:30", label: "14:30", available: true, note: "余量充足" },
  { value: "16:00", label: "16:00", available: false, note: "已约满" },
  { value: "18:30", label: "18:30", available: true, note: "余 1 位" },
];

Page({
  data: {
    guestCounts: [
      { count: 1, enabled: true },
      { count: 2, enabled: false },
      { count: 3, enabled: false },
      { count: 4, enabled: false },
    ] satisfies GuestCountOption[],
    guestCount: 1,
    services,
    selectedService: services[0]!,
    dates: initialDates,
    selectedDateKey: initialDates[0]?.key ?? "",
    selectedDateLabel: initialDates[0]?.summaryLabel ?? "",
    timeOptions,
    selectedTime: "11:00",
    therapists,
    selectedTherapist: therapists[0]!,
    totalLabel: totalLabel(services[0]!.priceCents, 1),
    summaryExpanded: false,
  },

  onShow() {
    const dates = buildDateOptions(new Date(), storeTimezone);
    const selectedDate =
      dates.find((item) => item.key === this.data.selectedDateKey) ?? dates[0];
    if (!selectedDate) return;
    this.setData({
      dates,
      selectedDateKey: selectedDate.key,
      selectedDateLabel: selectedDate.summaryLabel,
    });
  },

  selectGuestCount(event: WechatMiniprogram.TouchEvent) {
    const guestCount = Number(event.currentTarget.dataset.count);
    const option = this.data.guestCounts.find(
      (item) => item.count === guestCount,
    );
    if (!Number.isInteger(guestCount) || !option?.enabled) return;
    this.setData({
      guestCount,
      totalLabel: totalLabel(this.data.selectedService.priceCents, guestCount),
    });
  },

  selectService(event: WechatMiniprogram.TouchEvent) {
    const service = services.find(
      (item) => item.id === event.currentTarget.dataset.id,
    );
    if (!service) return;
    this.setData({
      selectedService: service,
      totalLabel: totalLabel(service.priceCents, this.data.guestCount),
    });
  },

  selectDate(event: WechatMiniprogram.TouchEvent) {
    const selectedDateKey = String(event.currentTarget.dataset.key ?? "");
    const selectedDate = this.data.dates.find(
      (item) => item.key === selectedDateKey,
    );
    if (selectedDate) {
      this.setData({
        selectedDateKey,
        selectedDateLabel: selectedDate.summaryLabel,
      });
    }
  },

  selectTime(event: WechatMiniprogram.TouchEvent) {
    const value = String(event.currentTarget.dataset.value ?? "");
    const option = timeOptions.find((item) => item.value === value);
    if (option?.available) this.setData({ selectedTime: value });
  },

  selectTherapist(event: WechatMiniprogram.TouchEvent) {
    const therapist = therapists.find(
      (item) => item.id === event.currentTarget.dataset.id,
    );
    if (therapist) this.setData({ selectedTherapist: therapist });
  },

  showBookingSummary() {
    this.setData({ summaryExpanded: true });
  },

  hideBookingSummary() {
    this.setData({ summaryExpanded: false });
  },
});
