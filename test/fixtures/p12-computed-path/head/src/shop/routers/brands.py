from fastapi import APIRouter, HTTPException

from shop.models import Brand
from shop.services.brands import BrandService

router = APIRouter()
service = BrandService()


def path(name: str) -> str:
    return "/" + name


brand_id = path("{brand_id}")


@router.get(brand_id)
def get_brand_v2(brand_id: str) -> Brand:
    return Brand(id=brand_id, name="")


@router.get("")
def list_brands() -> list[Brand]:
    return service.list()


@router.get("/{brand_id}")
def get_brand(brand_id: str) -> Brand:
    brand = service.find(brand_id)
    if brand is None:
        raise HTTPException(status_code=404)
    return brand
