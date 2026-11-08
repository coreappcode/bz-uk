import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchProducts } from '../lib/productService';

const { from, select, categoryLookup } = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
  categoryLookup: vi.fn(),
}));

vi.mock('../lib/supabase', () => {
  const product = { id: 'product', category: 'category' };
  const query = {
    select: (fields: string, options?: unknown) => { select(fields, options); return query; },
    eq: () => query,
    or: () => query,
    order: () => query,
    range: () => query,
    in: (field: string) => {
      if (field === 'id') categoryLookup();
      return query;
    },
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: from.mock.lastCall?.[0] === 'products' ? [product] : [], error: null, count: null }).then(resolve),
  };
  from.mockReturnValue(query);
  return { supabase: { from } };
});

vi.mock('../lib/notificationService', () => ({
  notifyAccountEvent: vi.fn(),
  notifyAdminsOfEvent: vi.fn(),
}));

describe('category product fetch', () => {
  beforeEach(() => {
    from.mockClear();
    select.mockClear();
    categoryLookup.mockClear();
  });

  it('skips unused category enrichment and exact count when requested', async () => {
    await fetchProducts({ categoryIds: ['category'], includeCount: false, resolveCategoryNames: false });

    expect(select).toHaveBeenCalledWith('*', undefined);
    expect(categoryLookup).not.toHaveBeenCalled();
    expect(from).toHaveBeenCalledWith('product_variants');
  });

  it('preserves the default count and category enrichment', async () => {
    await fetchProducts();

    expect(select).toHaveBeenCalledWith('*', { count: 'exact' });
    expect(categoryLookup).toHaveBeenCalled();
  });
});
