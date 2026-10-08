/**
 * Development fixture catalog.
 *
 * Sample data, clearly marked as such everywhere it surfaces. It is shaped to
 * exercise the parts of the system that are hard to test with live data:
 *
 *   - The same product with a real GTIN across two providers, so the matcher
 *     can produce an EXACT_MATCH and the comparison view has something to show.
 *   - The same model in two capacities, so a variant conflict is exercised and
 *     the UI must refuse to put them on one price row.
 *   - A cheap, superficially similar product in the same category, so budget
 *     ranking has to decide between "₪110 and actually what you asked for" and
 *     "₪12 and merely under your ceiling" (rule 9).
 *   - Listings with shipping absent, so total cost degrades to an estimate.
 *   - Listings with no identifiers at all, so the matcher has to decline.
 *
 * Prices are plausible but arbitrary. Nothing here is a real offer, and the
 * `DEMO_FIXTURE` provenance means no surface presents it as one.
 */

export interface DemoListing {
  readonly providerId: string;
  readonly providerProductId: string;
  readonly title: string;
  readonly brand?: string;
  readonly model?: string;
  readonly gtin?: string;
  readonly mpn?: string;
  readonly capacity?: string;
  readonly colour?: string;
  readonly categoryPath: ReadonlyArray<string>;
  readonly price: string;
  readonly referencePrice?: string;
  readonly currency: string;
  /** Omitted entirely when the source would not report shipping. */
  readonly shipping?: number;
  readonly shippingDays?: { readonly low: number; readonly high: number };
  readonly rating?: number;
  readonly reviewCount?: number;
  readonly sourceUrl: string;
  readonly demoCoupon?: {
    readonly code: string;
    readonly title: string;
    readonly percent: number;
  };
}

export const DEMO_CATALOG: ReadonlyArray<DemoListing> = [
  // --- A real cross-source match: same GTIN on two providers --------------
  {
    providerId: 'amazon',
    providerProductId: 'B0DEMOANC01',
    title: 'Soundcore by Anker Life Q30 Wireless Over-Ear Headphones, Hybrid Active Noise Cancelling',
    brand: 'Soundcore',
    model: 'A3028',
    gtin: '00194644042974',
    mpn: 'A3028011',
    colour: 'Black',
    categoryPath: ['electronics', 'audio', 'headphones'],
    price: '79.99',
    currency: 'USD',
    // Amazon's API does not give a destination shipping cost, so the fixture
    // does not pretend to either: this stays absent and the total is a range.
    rating: undefined,
    reviewCount: undefined,
    sourceUrl: 'https://www.amazon.com/dp/B0DEMOANC01?tag=demo-20',
  },
  {
    providerId: 'aliexpress',
    providerProductId: '1005001234567001',
    title:
      'Soundcore Life Q30 Wireless Headphones Hybrid Active Noise Cancelling Bluetooth Headset A3028 Original',
    brand: 'Soundcore',
    model: 'A3028',
    gtin: '00194644042974',
    colour: 'Black',
    categoryPath: ['consumer-electronics', 'earphones-headphones'],
    price: '68.40',
    referencePrice: '96.00',
    currency: 'USD',
    shipping: 4.21,
    shippingDays: { low: 12, high: 25 },
    rating: 4.7,
    reviewCount: 3184,
    sourceUrl: 'https://www.aliexpress.com/item/1005001234567001.html',
    demoCoupon: { code: 'DEMOSAVE8', title: 'Sample store coupon', percent: 8 },
  },

  // --- Variant conflict: same model, different capacity -------------------
  {
    providerId: 'amazon',
    providerProductId: 'B0DEMOSSD64',
    title: 'SanDisk Ultra 64GB microSDXC UHS-I Memory Card with Adapter',
    brand: 'SanDisk',
    model: 'SDSQUAB064G',
    gtin: '00619659200510',
    mpn: 'SDSQUAB064GGN6MA',
    capacity: '64GB',
    categoryPath: ['electronics', 'storage', 'memory-cards'],
    price: '9.49',
    currency: 'USD',
    sourceUrl: 'https://www.amazon.com/dp/B0DEMOSSD64?tag=demo-20',
  },
  {
    providerId: 'aliexpress',
    providerProductId: '1005001234567002',
    title: 'SanDisk Ultra microSD Card 128GB UHS-I Class 10 Memory Card with SD Adapter',
    brand: 'SanDisk',
    model: 'SDSQUAB128G',
    capacity: '128GB',
    categoryPath: ['consumer-electronics', 'memory-cards'],
    price: '11.80',
    referencePrice: '18.90',
    currency: 'USD',
    shipping: 1.99,
    shippingDays: { low: 10 ,high: 22 },
    rating: 4.8,
    reviewCount: 9241,
    sourceUrl: 'https://www.aliexpress.com/item/1005001234567002.html',
  },

  // --- Budget trap: cheap and under the ceiling, but not what was asked ---
  {
    providerId: 'aliexpress',
    providerProductId: '1005001234567003',
    title: 'Wireless Earbuds Bluetooth 5.3 Headphones Sport Earphone with Charging Case',
    categoryPath: ['consumer-electronics', 'earphones-headphones'],
    price: '3.21',
    referencePrice: '7.90',
    currency: 'USD',
    shipping: 2.14,
    shippingDays: { low: 15, high: 32 },
    rating: 4.2,
    reviewCount: 412,
    sourceUrl: 'https://www.aliexpress.com/item/1005001234567003.html',
  },
  {
    providerId: 'temu',
    providerProductId: '601099512345003',
    title: 'TWS Bluetooth Earbuds Touch Control Noise Reduction In-Ear Headphones',
    categoryPath: ['electronics', 'headphones'],
    price: '4.78',
    referencePrice: '12.99',
    currency: 'USD',
    shipping: 0,
    shippingDays: { low: 7, high: 14 },
    rating: 4.1,
    reviewCount: 1877,
    sourceUrl: 'https://www.temu.com/demo-earbuds_g-601099512345003.html',
  },

  // --- A genuine mid-budget match for "headphones up to 120" --------------
  {
    providerId: 'amazon',
    providerProductId: 'B0DEMOSONY5',
    title: 'Sony WH-CH720N Noise Cancelling Wireless Bluetooth Headphones',
    brand: 'Sony',
    model: 'WHCH720N',
    gtin: '00027242925557',
    mpn: 'WHCH720N/B',
    colour: 'Black',
    categoryPath: ['electronics', 'audio', 'headphones'],
    price: '98.00',
    currency: 'USD',
    sourceUrl: 'https://www.amazon.com/dp/B0DEMOSONY5?tag=demo-20',
  },
  {
    providerId: 'aliexpress',
    providerProductId: '1005001234567004',
    title: 'Sony WH-CH720N Wireless Noise Cancelling Headphones Bluetooth Over Ear Headset Original',
    brand: 'Sony',
    model: 'WHCH720N',
    gtin: '00027242925557',
    colour: 'Black',
    categoryPath: ['consumer-electronics', 'earphones-headphones'],
    price: '91.25',
    referencePrice: '129.00',
    currency: 'USD',
    shipping: 0,
    shippingDays: { low: 9, high: 18 },
    rating: 4.8,
    reviewCount: 642,
    sourceUrl: 'https://www.aliexpress.com/item/1005001234567004.html',
  },

  // --- USB-C chargers: wattage as a variant attribute --------------------
  {
    providerId: 'amazon',
    providerProductId: 'B0DEMOCHG65',
    title: 'Anker 735 Charger Nano II 65W USB-C Wall Charger GaN',
    brand: 'Anker',
    model: 'A2668',
    gtin: '00194644088699',
    mpn: 'A2668111',
    categoryPath: ['electronics', 'accessories', 'chargers'],
    price: '45.99',
    currency: 'USD',
    sourceUrl: 'https://www.amazon.com/dp/B0DEMOCHG65?tag=demo-20',
  },
  {
    providerId: 'temu',
    providerProductId: '601099512345005',
    title: '65W GaN Fast Charger USB C Type C PD Wall Adapter 3 Port',
    categoryPath: ['electronics', 'chargers'],
    price: '12.49',
    referencePrice: '29.99',
    currency: 'USD',
    shipping: 0,
    shippingDays: { low: 6, high: 13 },
    rating: 4.4,
    reviewCount: 5120,
    sourceUrl: 'https://www.temu.com/demo-charger_g-601099512345005.html',
    demoCoupon: { code: 'DEMOFIRST15', title: 'Sample new-customer offer', percent: 15 },
  },

  // --- Mechanical keyboard, mid-range ------------------------------------
  {
    providerId: 'aliexpress',
    providerProductId: '1005001234567006',
    title: 'Keychron K2 V2 Wireless Mechanical Keyboard 75% Layout Hot-swappable RGB Brown Switch',
    brand: 'Keychron',
    model: 'K2V2',
    categoryPath: ['computer-office', 'keyboards'],
    price: '72.90',
    referencePrice: '89.00',
    currency: 'USD',
    shipping: 9.8,
    shippingDays: { low: 11, high: 24 },
    rating: 4.9,
    reviewCount: 1203,
    sourceUrl: 'https://www.aliexpress.com/item/1005001234567006.html',
  },

  // --- Robot vacuum, above a 200-unit budget -----------------------------
  {
    providerId: 'amazon',
    providerProductId: 'B0DEMOVAC01',
    title: 'eufy by Anker RoboVac 11S MAX Robot Vacuum Cleaner Slim BoostIQ',
    brand: 'eufy',
    model: 'T2123',
    gtin: '00194644001483',
    mpn: 'T2123311',
    categoryPath: ['home', 'cleaning', 'robot-vacuums'],
    price: '159.99',
    currency: 'USD',
    sourceUrl: 'https://www.amazon.com/dp/B0DEMOVAC01?tag=demo-20',
  },

  // --- Dash cam, no identifiers anywhere: matcher must decline ------------
  {
    providerId: 'temu',
    providerProductId: '601099512345007',
    title: 'Car DVR Dash Cam Full HD 1080P Night Vision Driving Recorder Dual Lens',
    categoryPath: ['automotive', 'dash-cameras'],
    price: '18.90',
    referencePrice: '42.00',
    currency: 'USD',
    shipping: 0,
    shippingDays: { low: 8, high: 16 },
    rating: 4.3,
    reviewCount: 2904,
    sourceUrl: 'https://www.temu.com/demo-dashcam_g-601099512345007.html',
  },
  {
    providerId: 'aliexpress',
    providerProductId: '1005001234567008',
    title: '1080P Dash Camera for Car Video Recorder G-sensor Loop Recording Wide Angle',
    categoryPath: ['automobiles', 'dvr-dash-camera'],
    price: '21.40',
    currency: 'USD',
    shipping: 3.5,
    shippingDays: { low: 14, high: 30 },
    rating: 4.5,
    reviewCount: 877,
    sourceUrl: 'https://www.aliexpress.com/item/1005001234567008.html',
  },
];

/** Listings for one provider, used when a single source is being demoed. */
export function demoListingsFor(providerId: string): ReadonlyArray<DemoListing> {
  return DEMO_CATALOG.filter((listing) => listing.providerId === providerId);
}
