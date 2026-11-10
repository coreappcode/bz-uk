import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { MapPin, Plus, Loader2 } from 'lucide-react';
import { useCart } from '../../contexts/CartContext';
import { useAuth } from '../../contexts/AuthContext';
import { Skeleton, ListSkeleton } from '../../components/common/Skeleton';
import { Header } from '../../components/layout/Header';
import { Footer } from '../../components/layout/Footer';
import { MobileNav } from '../../components/layout/MobileNav';
import { useCurrency } from '../../contexts/CurrencyContext';
import { createUserAddress, getUserAddresses } from '../../lib/adminService';
import type { UserAddress } from '../../types';
import {
  calculateDestinationCheckoutPricing,
  type DestinationCheckoutPricing,
} from '../../lib/checkoutPricingService';
import { fetchPublicProductPrices } from '../../lib/pricingService';
import { formatCurrency, hasCurrencyRate, isExchangeRateUnavailable } from '../../utils/currency';
import { detectLocationWithCaching } from '../../lib/locationService';
import { fetchCountries, type Country } from '../../lib/shippingDataService';
import {
  IS_UK_STOREFRONT,
  isUKCountry,
  STOREFRONT_COUNTRY_CODE,
  STOREFRONT_COUNTRY_NAME,
  STOREFRONT_CURRENCY_CODE,
} from '../../config/market';

interface ShippingFormData {
  full_name: string;
  phone_number: string;
  email: string;
  country: string;
  street_address_1: string;
  street_address_2?: string;
  city: string;
  state: string;
  postal_code: string;
  delivery_notes?: string;
}

const createEmptyShippingFormData = (): ShippingFormData => ({
  full_name: '',
  phone_number: '',
  email: '',
  country: IS_UK_STOREFRONT ? STOREFRONT_COUNTRY_NAME : '',
  street_address_1: '',
  street_address_2: '',
  city: '',
  state: '',
  postal_code: '',
  delivery_notes: '',
});

const getShippingDraftKey = (userId: string): string =>
  `beauzead_checkout_shipping_draft:${IS_UK_STOREFRONT ? 'GB' : 'GLOBAL'}:${userId}`;

const removeShippingDraft = (userId: string): void => {
  try {
    localStorage.removeItem(getShippingDraftKey(userId));
  } catch (err) {
    console.error('Unable to remove checkout address draft:', err);
  }
};

const ShippingAddressPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { items } = useCart();
  const { user, currentAuthUser, loading: authLoading } = useAuth();
  const { rates } = useCurrency();
  const [useExistingAddress, setUseExistingAddress] = useState(true);
  const [savedAddresses, setSavedAddresses] = useState<UserAddress[]>([]);
  const [addressesError, setAddressesError] = useState(false);
  const [addressesRetry, setAddressesRetry] = useState(0);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pageReady, setPageReady] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);
  const [error, setError] = useState('');
  const [locationError, setLocationError] = useState('');
  const [pricing, setPricing] = useState<DestinationCheckoutPricing | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [publicPriceMap, setPublicPriceMap] = useState<Record<string, number>>({});
  const [publicPriceLoading, setPublicPriceLoading] = useState(false);
  const [addressSelectionLoading, setAddressSelectionLoading] = useState(false);
  const [countryOptions, setCountryOptions] = useState<Country[]>([]);
  const [selectedCartItemIds, setSelectedCartItemIds] = useState<string[]>([]);
  const [draftOwnerId, setDraftOwnerId] = useState<string | null>(null);
  const [draftSaveError, setDraftSaveError] = useState(false);
  const pricingRequestRef = useRef(0);
  const hydratedDraftUserRef = useRef<string | null>(null);
  const draftRef = useRef<ShippingFormData | null>(null);

  const [formData, setFormData] = useState<ShippingFormData>(createEmptyShippingFormData);

  // Load saved addresses from Supabase or fallback to localStorage
  useEffect(() => {
    const routeSelected = (location.state as any)?.selectedCartItemIds as string[] | undefined;
    const persisted = localStorage.getItem('beauzead_checkout_selected_cart_ids');
    let parsedPersisted: string[] = [];
    try { parsedPersisted = persisted ? (JSON.parse(persisted) as string[]) : []; } catch { /* corrupted */ }
    const source = Array.isArray(routeSelected) && routeSelected.length > 0 ? routeSelected : parsedPersisted;

    if (source.length > 0) {
      setSelectedCartItemIds(source);
      localStorage.setItem('beauzead_checkout_selected_cart_ids', JSON.stringify(source));
      return;
    }

    const allIds = items.map((item) => item.cartItemId);
    setSelectedCartItemIds(allIds);
    localStorage.setItem('beauzead_checkout_selected_cart_ids', JSON.stringify(allIds));
  }, [items, location.state]);

  const activeCartItems = useMemo(
    () => items.filter((item) => selectedCartItemIds.includes(item.cartItemId)),
    [items, selectedCartItemIds],
  );

  const destinationCountryForPricing = IS_UK_STOREFRONT
    ? STOREFRONT_COUNTRY_NAME
    : formData.country || user?.country || '';

  useEffect(() => {
    const loadPublicPrices = async () => {
      if (!destinationCountryForPricing) {
        setPublicPriceMap({});
        setPublicPriceLoading(true);
        return;
      }

      if (activeCartItems.length === 0) {
        setPublicPriceMap({});
        setPublicPriceLoading(false);
        return;
      }

      setPublicPriceLoading(true);
      const { data } = await fetchPublicProductPrices(
        activeCartItems.map((item) => item.product.id),
        destinationCountryForPricing,
      );
      const map: Record<string, number> = {};
      (data || []).forEach((item) => {
        map[item.productId] = item.publicUnitPrice;
      });
      setPublicPriceMap(map);
      setPublicPriceLoading(false);
    };

    void loadPublicPrices();
  }, [activeCartItems, destinationCountryForPricing]);

  const hasUnresolvedPublicPrices = activeCartItems.some(
    (item) => typeof publicPriceMap[item.product.id] !== 'number'
      && typeof item.variantPrice !== 'number'
      && typeof item.product.price !== 'number'
  );

  const pricingItems = useMemo(
    () => activeCartItems.map((item) => ({
      cartItemId: item.cartItemId,
      productId: item.product.id,
      productName: item.product.name,
      quantity: item.quantity,
      unitPrice: item.variantPrice ?? publicPriceMap[item.product.id] ?? item.product.price ?? 0,
      currency: item.product.currency || 'INR',
      selectedVariantId: item.selectedVariantId,
      selectedVariantSku: item.selectedVariantSku,
      selectedSize: item.selectedSize,
      selectedColor: item.selectedColor,
    })),
    [activeCartItems, publicPriceMap],
  );

  useEffect(() => {
    const loadCountries = async () => {
      const { data } = await fetchCountries();
      const countries = data || [];
      setCountryOptions(
        IS_UK_STOREFRONT
          ? countries.filter((country) =>
              isUKCountry(country.country_name)
              || isUKCountry(country.country_code)
              || isUKCountry(country.short_code))
          : countries,
      );
    };

    void loadCountries();
  }, []);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    const loadSavedAddresses = async () => {
      try {
        const userId = user?.id || currentAuthUser?.userId;
        if (!userId) {
          navigate('/login', { state: { from: '/checkout/shipping' } });
          return;
        }

        let restoredDraft: ShippingFormData | null = null;
        if (hydratedDraftUserRef.current !== userId) {
          const emptyForm = createEmptyShippingFormData();
          try {
            const savedDraft = localStorage.getItem(getShippingDraftKey(userId));
            if (savedDraft) {
              const parsed = JSON.parse(savedDraft) as { formData?: Partial<ShippingFormData> };
              if (parsed.formData && typeof parsed.formData === 'object') {
                restoredDraft = Object.fromEntries(
                  Object.entries(emptyForm).map(([key, fallback]) => [
                    key,
                    typeof parsed.formData?.[key as keyof ShippingFormData] === 'string'
                      ? parsed.formData[key as keyof ShippingFormData]
                      : fallback,
                  ]),
                ) as ShippingFormData;
                if (IS_UK_STOREFRONT) restoredDraft.country = STOREFRONT_COUNTRY_NAME;
              }
            }
          } catch (err) {
            console.error('Unable to restore checkout address draft:', err);
            removeShippingDraft(userId);
          }

          hydratedDraftUserRef.current = userId;
          draftRef.current = restoredDraft;
          setDraftOwnerId(userId);
          setFormData(restoredDraft || emptyForm);
          setSelectedAddressId(null);
          setUseExistingAddress(true);
        }

        const result = await getUserAddresses(userId);
        if (cancelled) return;
        if (result.error) throw new Error(result.error);
        setAddressesError(false);
        if (result.data && result.data.length > 0) {
          const addresses = result.data.map((a: any) => ({
            id: a.id,
            full_name: a.full_name || '',
            phone_number: a.phone_number || '',
            email: a.email || '',
            country: a.country || '',
            street_address_1: a.street_address_1 || '',
            street_address_2: a.street_address_2 || '',
            city: a.city || '',
            state: a.state || '',
            postal_code: a.postal_code || '',
            delivery_notes: a.delivery_notes || '',
            is_default: a.is_default || false,
          })) as UserAddress[];
          const supportedAddresses = IS_UK_STOREFRONT
            ? addresses.filter((address) => isUKCountry(address.country))
            : addresses;
          setSavedAddresses(addresses);

          const defaultAddress = supportedAddresses.find(addr => addr.is_default) || supportedAddresses[0];
          if (defaultAddress) {
            setSelectedAddressId(defaultAddress.id);
            setUseExistingAddress(true);
            // Populate formData so pricing runs with postal code immediately
            setFormData(prev => ({
              ...prev,
              full_name: defaultAddress.full_name || prev.full_name,
              phone_number: defaultAddress.phone_number || prev.phone_number,
              email: defaultAddress.email || prev.email,
              country: IS_UK_STOREFRONT
                ? STOREFRONT_COUNTRY_NAME
                : defaultAddress.country || prev.country,
              street_address_1: defaultAddress.street_address_1 || '',
              street_address_2: defaultAddress.street_address_2 || '',
              city: defaultAddress.city || '',
              state: defaultAddress.state || '',
              postal_code: defaultAddress.postal_code || '',
              delivery_notes: defaultAddress.delivery_notes || '',
            }));
          }
        } else {
          setSavedAddresses([]);
          setSelectedAddressId(null);
        }

        // Pre-fill from auth context
        const name = user?.full_name || '';
        const email = user?.email || currentAuthUser?.email || '';
        const phone = user?.phone || '';
        if (name || email || phone) {
          setFormData(prev => ({
            ...prev,
            full_name: prev.full_name || name,
            email: prev.email || email,
            phone_number: prev.phone_number || phone,
          }));
        }
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load addresses:', err);
        setAddressesError(true);
      } finally {
        if (!cancelled) setPageReady(true);
      }
    };

    void loadSavedAddresses();
    return () => { cancelled = true; };
  }, [user?.id, user?.full_name, user?.email, user?.phone, currentAuthUser?.userId, currentAuthUser?.email, authLoading, navigate, addressesRetry]);

  // Redirect if cart is empty
  useEffect(() => {
    if (items.length === 0) {
      navigate('/cart');
      return;
    }

    if (selectedCartItemIds.length > 0 && activeCartItems.length === 0) {
      navigate('/cart');
    }
  }, [items.length, selectedCartItemIds.length, activeCartItems.length, navigate]);

  useEffect(() => {
    const destinationCountry = destinationCountryForPricing;
    if (pricingItems.length === 0) {
      setPricing(null);
      setPricingLoading(false);
      return;
    }

    if (hasUnresolvedPublicPrices) {
      setPricingLoading(false);
      return;
    }

    const requestId = pricingRequestRef.current + 1;
    pricingRequestRef.current = requestId;
    setPricingLoading(true);
    setPricing(null);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const data = await calculateDestinationCheckoutPricing({
            items: pricingItems,
            destinationCountry,
            destinationPostalCode: formData.postal_code,
            rates,
          });
          if (pricingRequestRef.current === requestId) {
            setPricing(data);
          }
        } catch (err) {
          console.error('Failed to refresh checkout pricing:', err);
          if (pricingRequestRef.current === requestId) {
            setError(err instanceof Error
              ? err.message
              : 'Unable to load checkout pricing. Please refresh and try again.');
            setPricing(null);
          }
        } finally {
          if (pricingRequestRef.current === requestId) {
            setPricingLoading(false);
          }
        }
      })();
    }, 250);

    return () => {
      window.clearTimeout(timer);
      if (pricingRequestRef.current === requestId) pricingRequestRef.current += 1;
    };
  }, [destinationCountryForPricing, formData.postal_code, pricingItems, rates, hasUnresolvedPublicPrices]);

  useEffect(() => {
    if (!pricingLoading) {
      setAddressSelectionLoading(false);
    }
  }, [pricingLoading]);

  const targetCurrency = (
    pricing?.currency || (IS_UK_STOREFRONT ? STOREFRONT_CURRENCY_CODE : 'INR')
  ).toUpperCase();
  const requiresFxConversion = Boolean(
    pricing?.items?.some((line) => String(line.sourceCurrency || '').toUpperCase() !== targetCurrency)
  );
  const fxUnavailableForCheckout = IS_UK_STOREFRONT
    ? !hasCurrencyRate(STOREFRONT_CURRENCY_CODE, rates)
      || Boolean(pricing?.items?.some((line) =>
        String(line.sourceCurrency || '').toUpperCase() !== STOREFRONT_CURRENCY_CODE
        && !hasCurrencyRate(line.sourceCurrency, rates)))
    : requiresFxConversion && isExchangeRateUnavailable();

  const hasSelectedCountryOption = countryOptions.some((country) => country.country_name === formData.country);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    const next = { ...formData, [name]: value };
    if (draftOwnerId) {
      try {
        localStorage.setItem(
          getShippingDraftKey(draftOwnerId),
          JSON.stringify({ formData: next, updatedAt: Date.now() }),
        );
        setDraftSaveError(false);
      } catch (err) {
        console.error('Unable to save checkout address draft:', err);
        setDraftSaveError(true);
      }
    }
    draftRef.current = next;
    setFormData(next);
  };

  const handleSelectAddress = (address: UserAddress) => {
    setDraftSaveError(false);
    setError('');
    setUseExistingAddress(true);
    setSelectedAddressId(address.id);
    setAddressSelectionLoading(true);

    // Some saved-address rows may not include email/phone. Preserve the prefilled
    // values from auth/context so the user doesn't get stuck without an error.
    const fallbackEmail = user?.email || currentAuthUser?.email || formData.email;
    const fallbackPhone = (user as any)?.phone || formData.phone_number;

    setFormData({
      full_name: address.full_name || formData.full_name,
      phone_number: address.phone_number || fallbackPhone || '',
      email: address.email || fallbackEmail || '',
      country: IS_UK_STOREFRONT
        ? STOREFRONT_COUNTRY_NAME
        : address.country || formData.country,
      street_address_1: address.street_address_1 || '',
      street_address_2: address.street_address_2 || '',
      city: address.city || '',
      state: address.state || '',
      postal_code: address.postal_code || '',
      delivery_notes: address.delivery_notes || '',
    });
  };

  const handleNewAddress = () => {
    setError('');
    setFormData(draftRef.current || {
      ...createEmptyShippingFormData(),
      full_name: user?.full_name || '',
      phone_number: user?.phone || '',
      email: user?.email || currentAuthUser?.email || '',
    });
    setUseExistingAddress(false);
  };

  const handleBackToAddresses = () => {
    setError('');
    setUseExistingAddress(true);
    const supported = savedAddresses.filter((address) => !IS_UK_STOREFRONT || isUKCountry(address.country));
    const previous = supported.find((address) => address.id === selectedAddressId)
      || supported.find((address) => address.is_default) || supported[0];
    if (previous) handleSelectAddress(previous);
  };

  const validateForm = (): boolean => {
    if (IS_UK_STOREFRONT && !isUKCountry(formData.country)) {
      setError('UK storefront shipping addresses must be in the United Kingdom.');
      return false;
    }

    if (!formData.full_name.trim()) {
      setError('Full name is required');
      return false;
    }
    if (!formData.phone_number.trim()) {
      setError('Phone number is required');
      return false;
    }
    if (formData.phone_number.replace(/\D/g, '').length < 6) {
      setError('Phone number must have at least 6 digits');
      return false;
    }
    if (!formData.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim())) {
      setError('Valid email is required');
      return false;
    }
    if (!formData.street_address_1.trim()) {
      setError('Street address is required');
      return false;
    }
    if (!formData.city.trim()) {
      setError('City is required');
      return false;
    }
    if (!formData.state.trim()) {
      setError('State/Province is required');
      return false;
    }
    if (!formData.postal_code.trim()) {
      setError('Postal code is required');
      return false;
    }
    // M10: Basic postal code format validation
    const countryUpper = (formData.country || '').trim().toUpperCase();
    if (['INDIA', 'IN', 'IND'].includes(countryUpper) && !/^\d{6}$/.test(formData.postal_code.trim())) {
      setError('Indian postal code must be exactly 6 digits');
      return false;
    }
    if (!formData.country.trim()) {
      setError('Country is required');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e?: React.SyntheticEvent) => {
    e?.preventDefault?.();
    setError('');

    if (!validateForm()) {
      return;
    }

    if (pricingLoading) {
      setError('Refreshing shipping charges. Please wait a moment and try again.');
      return;
    }

    if (publicPriceLoading || hasUnresolvedPublicPrices) {
      setError('Final prices are still loading. Please wait a moment and try again.');
      return;
    }

    if (!pricing) {
      setError('Unable to calculate checkout prices and shipping. Please refresh and try again.');
      return;
    }

    if (fxUnavailableForCheckout) {
      setError('Live currency conversion is temporarily unavailable. Please try again in a moment.');
      return;
    }
    if (pricing.intlShippingError || pricing.domesticShippingError) {
      setError(pricing.intlShippingError || pricing.domesticShippingError || 'Shipping is not available for this address.');
      return;
    }

    setIsLoading(true);

    try {
      const userId = user?.id || currentAuthUser?.userId;
      let activeAddressId = selectedAddressId;

      if (userId && (!useExistingAddress || !selectedAddressId)) {
        const payload = {
          user_id: userId,
          full_name: formData.full_name,
          phone_number: formData.phone_number,
          email: formData.email,
          country: formData.country,
          street_address_1: formData.street_address_1,
          street_address_2: formData.street_address_2 || null,
          city: formData.city,
          state: formData.state,
          postal_code: formData.postal_code,
          delivery_notes: formData.delivery_notes || null,
          address_type: 'home',
          is_default: savedAddresses.length === 0,
        };

        const created = await createUserAddress(payload);
        if (created.error || !created.data) {
          throw new Error(created.error || 'Failed to save address to account.');
        }

        const newAddress = created.data as UserAddress;
        activeAddressId = newAddress.id;
        setSelectedAddressId(newAddress.id);
        setSavedAddresses((prev) => [newAddress, ...prev]);
      }

      // Store shipping address in localStorage for order summary page
      const selectedCountry = countryOptions.find((country) => country.country_name === formData.country);
      const selectedCountryCode = IS_UK_STOREFRONT
        ? STOREFRONT_COUNTRY_CODE
        : String(selectedCountry?.country_code || '').trim().toUpperCase();

      const shippingData = {
        street: formData.street_address_1,
        street2: formData.street_address_2,
        city: formData.city,
        state: formData.state,
        postalCode: formData.postal_code,
        country: formData.country,
        countryCode: selectedCountryCode || undefined,
        fullName: formData.full_name,
        phone: formData.phone_number,
        email: formData.email,
        notes: formData.delivery_notes,
        selectedAddressId: activeAddressId,
        selectedCartItemIds,
      };

      localStorage.setItem('beauzead_checkout_shipping', JSON.stringify(shippingData));
      if (userId) removeShippingDraft(userId);

      // Navigate to order summary
      navigate('/checkout/review');
    } catch (err) {
      console.error(err);
      setError('Unable to save shipping details right now. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUseCurrentLocation = async () => {
    if (locationLoading) return;

    setLocationLoading(true);
    setLocationError('');

    try {
      const userId = user?.id || currentAuthUser?.userId || null;
      const { data, error: detectError } = await detectLocationWithCaching({
        userId,
        forceRefresh: true,
      });

      if (detectError || !data) {
        setLocationError(detectError || 'Unable to fetch your location.');
        return;
      }

      setFormData((prev) => ({
        ...prev,
        // L3: Populate street_address_1 from place if empty (approximate from geolocation)
        street_address_1: prev.street_address_1 || data.place || prev.street_address_1,
        street_address_2: prev.street_address_2 || '',
        city: data.city || prev.city,
        state: data.state || prev.state,
        postal_code: data.postalCode || prev.postal_code,
        country: IS_UK_STOREFRONT
          ? STOREFRONT_COUNTRY_NAME
          : data.country || prev.country,
      }));
    } finally {
      setLocationLoading(false);
    }
  };

  if (!pageReady) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="w-full max-w-3xl mx-auto px-4 py-6 space-y-4">
          <div className="h-6 w-52 rounded bg-gray-200 animate-pulse mb-2" />
          <ListSkeleton rows={3} withAvatar={false} />
          <Skeleton rounded="2xl" className="h-40 w-full" />
        </div>
      </div>
    );
  }

  return (
    <>
    <Header />
    <div className="min-h-screen bg-slate-50 py-4 sm:py-6">
      <div className="max-w-[1100px] mx-auto px-4 pb-24 md:pb-5">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5">
        {/* LEFT COLUMN */}
        <div>
        <ol className="ship-steps" aria-label="Checkout progress">
          <li className="ship-step ship-step--active" aria-current="step"><span>1</span>Address</li>
          <li className="ship-step"><span>2</span>Review</li>
          <li className="ship-step"><span>3</span>Payment</li>
        </ol>
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 sm:p-6 mb-4">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-900 mb-4">
            {useExistingAddress ? 'Choose delivery address' : 'Add a new address'}
          </h1>

          {addressesError ? (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <p>We couldn&apos;t load your saved addresses. Please try again.</p>
              <button type="button" className="mt-2 font-semibold underline" onClick={() => setAddressesRetry((count) => count + 1)}>
                Retry
              </button>
            </div>
          ) : useExistingAddress ? (
            <>
              {savedAddresses.length === 0 ? (
                <p className="mb-4 text-sm text-slate-600">You have no saved addresses yet. Add one to continue.</p>
              ) : (
                <fieldset className="mb-4 space-y-3">
                  <legend className="sr-only">Saved addresses</legend>
                  {savedAddresses.map((address) => {
                    const unsupported = IS_UK_STOREFRONT && !isUKCountry(address.country);
                    return (
                      <label key={address.id} className={`flex gap-3 rounded-xl border-2 p-4 ${
                        selectedAddressId === address.id
                          ? 'border-[#6D28D9] bg-[#6D28D9]/5'
                          : 'border-slate-200 bg-white'
                      } ${unsupported ? 'opacity-70' : 'cursor-pointer hover:border-[#6D28D9]/50'}`}>
                        <input
                          type="radio"
                          name="saved-address"
                          value={address.id}
                          checked={selectedAddressId === address.id}
                          disabled={unsupported}
                          onChange={() => handleSelectAddress(address)}
                          className="mt-1 h-5 w-5 shrink-0 accent-[#6D28D9]"
                        />
                        <span className="min-w-0 flex-1 text-sm text-slate-600 leading-relaxed">
                          <span className="flex flex-wrap items-center gap-2 mb-1">
                            <span className="font-bold text-slate-900">{address.full_name}</span>
                            {address.is_default && <span className="rounded-full bg-[#6D28D9]/10 px-2 py-0.5 text-xs font-semibold text-[#6D28D9]">Default</span>}
                            {selectedAddressId === address.id && addressSelectionLoading && <Loader2 size={14} className="animate-spin text-[#6D28D9]" aria-label="Updating shipping" />}
                          </span>
                          <span className="block">{address.street_address_1}{address.street_address_2 && `, ${address.street_address_2}`}</span>
                          <span className="block">{[address.city, address.state, address.postal_code, address.country].filter(Boolean).join(', ')}</span>
                          {address.phone_number && <span className="block">{address.phone_number}</span>}
                          {unsupported && <span className="block mt-2 text-red-700">This UK storefront can only ship to a United Kingdom address.</span>}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              )}
              <button type="button" onClick={handleNewAddress} className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-[#6D28D9] px-4 py-3 font-semibold text-[#6D28D9] hover:bg-[#6D28D9]/5">
                <Plus size={18} /> Add a new address
              </button>
            </>
          ) : (
            <button type="button" onClick={handleBackToAddresses} className="mb-4 text-sm font-semibold text-[#6D28D9] hover:underline">
              ← Back to saved addresses
            </button>
          )}

          {/* New Address Form */}
          {!addressesError && !useExistingAddress && (
            <form onSubmit={handleSubmit} className="space-y-7">
              {/* Contact Information */}
              <div>
                <h3 className="ship-section-title">Contact information</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="shipping-full-name" className="ship-label">
                      Full Name <span className="text-red-500" aria-hidden>*</span>
                    </label>
                    <input
                      type="text"
                      id="shipping-full-name"
                      name="full_name"
                      autoComplete="name"
                      value={formData.full_name}
                      onChange={handleInputChange}
                      className="ship-input"
                      placeholder="John Doe"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="shipping-phone" className="ship-label">
                      Phone Number <span className="text-red-500" aria-hidden>*</span>
                    </label>
                    <input
                      type="tel"
                      id="shipping-phone"
                      name="phone_number"
                      autoComplete="tel" inputMode="tel"
                      value={formData.phone_number}
                      onChange={handleInputChange}
                      className="ship-input"
                      placeholder="+1 (555) 123-4567"
                      required
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label htmlFor="shipping-email" className="ship-label">
                    Email <span className="text-red-500" aria-hidden>*</span>
                  </label>
                  <input
                    type="email"
                    id="shipping-email"
                    name="email"
                      autoComplete="email" inputMode="email"
                    value={formData.email}
                    onChange={handleInputChange}
                    className="ship-input"
                    placeholder="john@example.com"
                    required
                  />
                </div>
              </div>

              {/* Address Details */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-4">
                  <h3 className="ship-section-title !mb-0">Address details</h3>
                  {!IS_UK_STOREFRONT && (
                    <button
                      type="button"
                      onClick={() => void handleUseCurrentLocation()}
                      disabled={locationLoading}
                      className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold text-[#6D28D9] bg-[#6D28D9]/5 border border-[#6D28D9]/20 rounded-xl hover:bg-[#6D28D9]/10 disabled:opacity-50"
                    >
                      {locationLoading ? <Loader2 size={14} className="animate-spin" /> : <MapPin size={14} />}
                      Use Current Location
                    </button>
                  )}
                </div>

                {locationError && (
                  <div className="mb-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
                    {locationError}
                  </div>
                )}

                <div className="space-y-4">
                  <div>
                    <label htmlFor="shipping-street" className="ship-label">
                      Street Address <span className="text-red-500" aria-hidden>*</span>
                    </label>
                    <input
                      type="text"
                      id="shipping-street"
                      name="street_address_1"
                      autoComplete="address-line1"
                      value={formData.street_address_1}
                      onChange={handleInputChange}
                      className="ship-input"
                      placeholder="123 Main Street"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="shipping-street-2" className="ship-label">
                      Apartment, Suite, etc. (Optional)
                    </label>
                    <input
                      type="text"
                      id="shipping-street-2"
                      name="street_address_2"
                      autoComplete="address-line2"
                      value={formData.street_address_2}
                      onChange={handleInputChange}
                      className="ship-input"
                      placeholder="Apt 4B"
                    />
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <div className="col-span-2 md:col-span-1">
                      <label htmlFor="shipping-city" className="ship-label">
                        City <span className="text-red-500" aria-hidden>*</span>
                      </label>
                      <input
                        type="text"
                        id="shipping-city"
                        name="city"
                      autoComplete="address-level2"
                        value={formData.city}
                        onChange={handleInputChange}
                        className="ship-input"
                        placeholder="New York"
                        required
                      />
                    </div>
                    <div>
                      <label htmlFor="shipping-state" className="ship-label">
                        {IS_UK_STOREFRONT ? 'County' : 'State/Province'} <span className="text-red-500" aria-hidden>*</span>
                      </label>
                      <input
                        type="text"
                        id="shipping-state"
                        name="state"
                      autoComplete="address-level1"
                        value={formData.state}
                        onChange={handleInputChange}
                        className="ship-input"
                        placeholder={IS_UK_STOREFRONT ? 'Greater London' : 'NY'}
                        required
                      />
                    </div>
                    <div>
                      <label htmlFor="shipping-postal-code" className="ship-label">
                        Postal Code <span className="text-red-500" aria-hidden>*</span>
                      </label>
                      <input
                        type="text"
                        id="shipping-postal-code"
                        name="postal_code"
                      autoComplete="postal-code"
                        value={formData.postal_code}
                        onChange={handleInputChange}
                        className="ship-input"
                        placeholder={IS_UK_STOREFRONT ? 'SW1A 1AA' : '10001'}
                        required
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="shipping-country" className="ship-label">
                      Country <span className="text-red-500" aria-hidden>*</span>
                    </label>
                    <select
                      id="shipping-country"
                      name="country"
                      value={formData.country}
                      onChange={handleInputChange}
                      className="ship-input"
                      disabled={IS_UK_STOREFRONT}
                      required
                    >
                      {IS_UK_STOREFRONT ? (
                        <option value={STOREFRONT_COUNTRY_NAME}>{STOREFRONT_COUNTRY_NAME}</option>
                      ) : (
                        <>
                          <option value="">Select Country</option>
                          {!hasSelectedCountryOption && formData.country && (
                            <option value={formData.country}>{formData.country}</option>
                          )}
                          {countryOptions.map((country) => (
                            <option key={country.id} value={country.country_name}>
                              {country.country_name}
                            </option>
                          ))}
                        </>
                      )}
                    </select>
                  </div>
                </div>
              </div>

              {/* Delivery Notes */}
              <div>
                <label htmlFor="shipping-notes" className="ship-label">
                  Delivery Notes (Optional)
                </label>
                <textarea
                  id="shipping-notes"
                  name="delivery_notes"
                  value={formData.delivery_notes}
                  onChange={handleInputChange}
                  rows={3}
                  className="ship-input resize-none"
                  placeholder="Any special instructions for delivery..."
                />
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-red-700">
                  {error}
                </div>
              )}

              {draftSaveError && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-amber-800" role="status">
                  Your address draft could not be saved on this device. Keep this page open until you continue checkout.
                </div>
              )}

              {fxUnavailableForCheckout && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-amber-700 text-sm">
                  Live currency conversion is temporarily unavailable. Checkout is paused until rates are available.
                </div>
              )}

              {pricingLoading && (
                <div className="bg-[#6D28D9]/5 border border-[#6D28D9]/20 rounded-xl px-4 py-3 text-[#5b21b6] text-sm">
                  Checking configured shipping table, then live carrier fallback...
                </div>
              )}

              {(publicPriceLoading || hasUnresolvedPublicPrices) && (
                <div className="bg-[#6D28D9]/5 border border-[#6D28D9]/20 rounded-xl px-4 py-3 text-[#5b21b6] text-sm">
                  Loading final item prices...
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading || pricingLoading || publicPriceLoading || hasUnresolvedPublicPrices || fxUnavailableForCheckout}
                className="ship-primary-btn"
              >
                {isLoading ? 'Saving...' : (pricingLoading || publicPriceLoading || hasUnresolvedPublicPrices) ? 'Refreshing Shipping...' : 'Continue to review order →'}
              </button>
            </form>
          )}

        </div>
        </div>{/* END LEFT COLUMN */}

        {/* RIGHT COLUMN — Order Summary */}
        <div>
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 sm:p-5 sticky top-24">
            <h2 className="text-base sm:text-lg font-bold text-slate-900 mb-3">Order summary</h2>

            <div className="space-y-1.5 sm:space-y-2 mb-2 sm:mb-3">
              <div className="flex justify-between text-[13px] sm:text-[14px]">
                <span className="text-[#555]">Items ({activeCartItems.length})</span>
                <span>{formatCurrency(pricing ? pricing.subtotal : Number.NaN, targetCurrency)}</span>
              </div>
              {(pricing?.offerDiscount || 0) > 0 && (
                <div className="flex justify-between text-[13px] sm:text-[14px] text-[#067d62] font-semibold">
                  <span>Savings</span>
                  <span>-{formatCurrency(pricing?.offerDiscount || 0, targetCurrency)}</span>
                </div>
              )}
              <div className="flex justify-between text-[13px] sm:text-[14px]">
                <span className="text-[#555]">Shipping</span>
                <span className="text-[#067d62] font-semibold">
                  {(!pricing || pricingLoading)
                    ? <span className="inline-block animate-pulse text-gray-400 text-xs">Calculating...</span>
                    : (pricing.shipping || 0) === 0 ? 'FREE' : formatCurrency(pricing.shipping || 0, targetCurrency)}
                </span>
              </div>
              {pricingLoading && (
                <div className="text-[11px] sm:text-xs text-gray-400">Checking table rates and carrier fallback...</div>
              )}
            </div>

            <div className="border-t border-slate-200 pt-2 sm:pt-3 mt-2 sm:mt-3 flex justify-between text-[15px] sm:text-[18px] font-bold text-slate-900">
              <span>Order Total</span>
              <span>{formatCurrency(pricing ? pricing.total : Number.NaN, targetCurrency)}</span>
            </div>

            <div className="flex items-center justify-center gap-1.5 text-[11px] sm:text-[12px] text-emerald-700 mt-3">
              🔒 Secure checkout powered by Stripe
            </div>
            {useExistingAddress && !addressesError && (
              <div className="mt-4">
                {!selectedAddressId && <p className="mb-3 text-sm text-slate-600">Select a supported address or add a new one to continue.</p>}
                {error && <div role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
                {fxUnavailableForCheckout && <p className="mb-3 text-sm text-amber-700">Live currency conversion is temporarily unavailable. Checkout is paused until rates are available.</p>}
                {pricingLoading && <p className="mb-3 text-sm text-slate-600" role="status">Checking shipping rates...</p>}
                {(publicPriceLoading || hasUnresolvedPublicPrices) && <p className="mb-3 text-sm text-slate-600" role="status">Loading final item prices...</p>}
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!selectedAddressId || isLoading || pricingLoading || publicPriceLoading || hasUnresolvedPublicPrices || fxUnavailableForCheckout}
                  className="ship-primary-btn"
                >
                  {isLoading ? 'Saving...' : (pricingLoading || publicPriceLoading || hasUnresolvedPublicPrices) ? 'Refreshing shipping...' : 'Continue to review'}
                </button>
              </div>
            )}
          </div>
        </div>
        </div>{/* END GRID */}
      </div>
    </div>
    <MobileNav />
    <Footer />
    </>
  );
};

export default ShippingAddressPage;
