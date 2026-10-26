import { listBrands } from '../services/brands'

export async function syncBrands() {
  return listBrands()
}
