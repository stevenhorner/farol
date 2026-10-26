from fastapi import FastAPI

from shop.routers import brands, users

app = FastAPI(title="shop")


def brands_prefix() -> str:
    return "/brands"


app.include_router(brands.router, prefix=brands_prefix())
app.include_router(users.router)


@app.get("/health")
def health() -> dict:
    return {"ok": True}
