/**
 * Response shapes for the Product Advertising API 5.0 operations we call.
 *
 * Every field is optional. PA-API returns only the resources you ask for, and
 * omits anything the item does not have — so a mapper that assumes presence
 * will throw on perfectly normal items. Making optionality explicit in the
 * types is what forces each read through the Datum mapping helpers.
 */

export interface PaapiDisplayValue {
  readonly DisplayValue?: string;
  readonly Label?: string;
  readonly Locale?: string;
}

export interface PaapiDisplayValues {
  readonly DisplayValues?: ReadonlyArray<string>;
}

export interface PaapiNumericDisplayValue {
  readonly DisplayValue?: number;
  readonly Label?: string;
  readonly Unit?: string;
}

export interface PaapiPrice {
  readonly Amount?: number;
  readonly Currency?: string;
  readonly DisplayAmount?: string;
  readonly Savings?: {
    readonly Amount?: number;
    readonly Currency?: string;
    readonly Percentage?: number;
  };
}

export interface PaapiImage {
  readonly URL?: string;
  readonly Height?: number;
  readonly Width?: number;
}

export interface PaapiListing {
  readonly Id?: string;
  readonly Price?: PaapiPrice;
  /** Provider's reference price, when it chooses to return one. */
  readonly SavingBasis?: PaapiPrice;
  readonly Availability?: {
    readonly Message?: string;
    readonly Type?: string;
    readonly MinOrderQuantity?: number;
  };
  readonly DeliveryInfo?: {
    readonly IsAmazonFulfilled?: boolean;
    readonly IsFreeShippingEligible?: boolean;
    readonly IsPrimeEligible?: boolean;
  };
  readonly MerchantInfo?: {
    readonly Name?: string;
    readonly Id?: string;
  };
  readonly Condition?: PaapiDisplayValue;
  readonly IsBuyBoxWinner?: boolean;
}

export interface PaapiItem {
  readonly ASIN?: string;
  /** Already carries the partner tag when PartnerTag was sent. */
  readonly DetailPageURL?: string;
  readonly ItemInfo?: {
    readonly Title?: PaapiDisplayValue;
    readonly ByLineInfo?: {
      readonly Brand?: PaapiDisplayValue;
      readonly Manufacturer?: PaapiDisplayValue;
    };
    readonly ExternalIds?: {
      readonly EANs?: PaapiDisplayValues;
      readonly UPCs?: PaapiDisplayValues;
      readonly ISBNs?: PaapiDisplayValues;
    };
    readonly Features?: PaapiDisplayValues;
    readonly ManufactureInfo?: {
      readonly ItemPartNumber?: PaapiDisplayValue;
      readonly Model?: PaapiDisplayValue;
      readonly Warranty?: PaapiDisplayValue;
    };
    readonly ProductInfo?: {
      readonly Color?: PaapiDisplayValue;
      readonly Size?: PaapiDisplayValue;
      readonly UnitCount?: PaapiNumericDisplayValue;
      readonly ItemDimensions?: {
        readonly Height?: PaapiNumericDisplayValue;
        readonly Length?: PaapiNumericDisplayValue;
        readonly Weight?: PaapiNumericDisplayValue;
        readonly Width?: PaapiNumericDisplayValue;
      };
    };
    readonly TechnicalInfo?: {
      readonly Formats?: PaapiDisplayValues;
    };
  };
  readonly Images?: {
    readonly Primary?: {
      readonly Large?: PaapiImage;
      readonly Medium?: PaapiImage;
    };
    readonly Variants?: ReadonlyArray<{
      readonly Large?: PaapiImage;
      readonly Medium?: PaapiImage;
    }>;
  };
  readonly Offers?: {
    readonly Listings?: ReadonlyArray<PaapiListing>;
    readonly Summaries?: ReadonlyArray<{
      readonly Condition?: PaapiDisplayValue;
      readonly LowestPrice?: PaapiPrice;
      readonly OfferCount?: number;
    }>;
  };
  readonly BrowseNodeInfo?: {
    readonly BrowseNodes?: ReadonlyArray<{
      readonly DisplayName?: string;
      readonly ContextFreeName?: string;
      readonly Id?: string;
      readonly Ancestor?: unknown;
    }>;
  };
}

export interface PaapiError {
  readonly Code?: string;
  readonly Message?: string;
}

export interface PaapiSearchResponse {
  readonly SearchResult?: {
    readonly TotalResultCount?: number;
    readonly SearchURL?: string;
    readonly Items?: ReadonlyArray<PaapiItem>;
  };
  readonly Errors?: ReadonlyArray<PaapiError>;
}

export interface PaapiGetItemsResponse {
  readonly ItemsResult?: {
    readonly Items?: ReadonlyArray<PaapiItem>;
  };
  readonly Errors?: ReadonlyArray<PaapiError>;
}

/**
 * Resources requested per operation.
 *
 * Kept narrow on purpose: PA-API counts resources against the request, and
 * asking for data we have no permission to display would mean receiving it and
 * then having to remember not to use it. Review resources are absent entirely
 * because the programme does not license displaying review content.
 */
export const SEARCH_RESOURCES: ReadonlyArray<string> = [
  'ItemInfo.Title',
  'ItemInfo.ByLineInfo',
  'ItemInfo.ExternalIds',
  'ItemInfo.Features',
  'ItemInfo.ManufactureInfo',
  'ItemInfo.ProductInfo',
  'Images.Primary.Large',
  'Offers.Listings.Price',
  'Offers.Listings.Availability.Message',
  'Offers.Listings.Availability.Type',
  'Offers.Listings.DeliveryInfo.IsFreeShippingEligible',
  'Offers.Listings.MerchantInfo',
  'BrowseNodeInfo.BrowseNodes',
];

export const GET_ITEMS_RESOURCES: ReadonlyArray<string> = [
  ...SEARCH_RESOURCES,
  'Images.Variants.Large',
  'ItemInfo.TechnicalInfo',
  'Offers.Listings.SavingBasis',
  'Offers.Summaries.LowestPrice',
];

/**
 * PA-API error codes mapped to our taxonomy.
 *
 * `TooManyRequests` is the one that matters operationally: the quota starts
 * around one request per second and shrinks if you exceed it, so it feeds the
 * rate limiter rather than being retried blindly.
 */
export function classifyPaapiError(code: string | undefined): {
  readonly kind: 'RATE_LIMIT' | 'AUTH' | 'INVALID_REQUEST' | 'NO_RESULTS' | 'UNKNOWN';
} {
  switch (code) {
    case 'TooManyRequests':
    case 'RequestThrottled':
      return { kind: 'RATE_LIMIT' };
    case 'UnrecognizedClient':
    case 'InvalidSignature':
    case 'InvalidAssociate':
    case 'AccessDenied':
    case 'IncompleteSignature':
      return { kind: 'AUTH' };
    case 'NoResults':
    case 'ItemNotAccessible':
      return { kind: 'NO_RESULTS' };
    case 'InvalidParameterValue':
    case 'MissingParameter':
    case 'InvalidPartnerTag':
    case 'InvalidMarketplace':
      return { kind: 'INVALID_REQUEST' };
    default:
      return { kind: 'UNKNOWN' };
  }
}
