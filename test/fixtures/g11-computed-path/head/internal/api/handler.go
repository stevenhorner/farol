package api

import (
	"encoding/json"
	"net/http"

	"example.com/shop/internal/model"
)

// BrandService lists and finds brands.
type BrandService interface {
	List() []model.Brand
	Get(id string) (model.Brand, bool)
}

// UserService answers questions about the signed-in user.
type UserService interface {
	Me() model.User
}

// Handler serves the HTTP API.
type Handler struct {
	brands BrandService
	users  UserService
}

func NewHandler(b BrandService, u UserService) *Handler {
	return &Handler{brands: b, users: u}
}

func (h *Handler) ListBrands(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, h.brands.List())
}

func (h *Handler) GetBrand(w http.ResponseWriter, r *http.Request) {
	b, ok := h.brands.Get(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, b)
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, h.users.Me())
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (h *Handler) CountBrands(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, len(h.brands.List()))
}
