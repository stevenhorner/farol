package main

import (
	"net/http"

	"example.com/shop/internal/api"
	"example.com/shop/internal/service"
	"example.com/shop/internal/store"
)

func route(method, name string) string {
	return method + " /" + name
}

var id = route("GET", "brands")

func main() {
	h := api.NewHandler(service.NewBrands(store.New()), service.NewUsers())
	mux := http.NewServeMux()
	mux.HandleFunc(id, h.CountBrands)
	mux.HandleFunc("GET /brands", h.ListBrands)
	mux.HandleFunc("GET /brands/{id}", h.GetBrand)
	mux.HandleFunc("GET /me", h.Me)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	_ = http.ListenAndServe(":8080", mux)
}
