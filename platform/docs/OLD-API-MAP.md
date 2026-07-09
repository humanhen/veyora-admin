# veyora.com (old system) — extracted reference

Extracted from the live production bundle (`/assets/index-DiRrKnNQ.js`) on 2026-07-09.
The new backend reimplements this surface so the rebuilt storefront behaves identically.

## Stack observed
- React SPA (Vite build) + MUI + Redux, PWA (service worker + manifest)
- Font: **Montserrat**; theme color `#221F20`; palette accents seen:
  `#170c34 #131e42 #32204e #324264 #56416d #64748b #b7c9dc #bda0d3 #ebf3f9 #f1e3f7 #fafbfc`
- Product images served same-origin at `/s3/...` (nginx reverse-proxy to a
  `veyora-products` bucket)
- Auth tokens in cookies prefixed `texashub_web_` (accessToken, refreshToken,
  role, email, country, hide_prices)
- Meta Pixel id 1800415057342259

## SPA routes
`/` (login), `/dashboard` + children: `products`, `cart`, `checkout`,
`thank-you/:order_id`, `orders`, `order-info/:order_id`, `backorders`,
`backorders/:backorderId`, `returns`, `returns/create`, `returns/:returnId`,
`favourites`, `spare-parts`, `my-account`, `account-details`,
`change-password`, `create-customer`, `my-agents`, `sa-customers`, `sa-leads`,
`tasks`, `tasks/:id`, `activate`, `otp-verify`, `forgot-password`

## API endpoints (base `veyora.com/veyora/api/`)

### auth/
| Constant | Path |
|---|---|
| USER_LOGIN | auth/login |
| LOGOUT | auth/logout |
| FORGOT_PASSWORD | auth/forgot-password |
| OTP_VERIFY_FORGOT_PASS | auth/verify-forgot-otp |
| RESET_PASSWORD | auth/reset-password |
| REQUEST_ACTIVATION_OTP | auth/request-activation-otp |
| VERIFY_ACTIVATION_OTP | auth/verify-activation-otp |
| SET_PASSWORD | auth/set-password |

### user/ — catalog & cart
| Constant | Path |
|---|---|
| GET_ALL_PRODUCTS | user/get-products |
| GET_PRODUCT_FILTERS | user/product-filter-data |
| TOP_SELLERS | user/products/top-sellers |
| GET_NEW_SINCE_LAST_LOGIN | user/new-since-last-login |
| ADD_TO_CART | user/add-to-cart |
| GET_CART_PRODUCTS | user/get-cart |
| REMOVE_CART_FROM_PRODUCT | user/delete-cart-item |
| CART_ITEM_NOTE | user/cart-item-note |
| CART_ITEM_LABELS | user/cart-item-labels |
| GET_CART_DRAFTS / SAVE / LOAD / DELETE | user/cart/drafts |
| PROMO_PREVIEW_CART | user/promotions/preview-cart |
| PROMO_ELIGIBLE | user/promotions/eligible |

### user/ — orders & fulfillment
| Constant | Path |
|---|---|
| PLACE_ORDER | user/place-order |
| ORDER_LIST | user/get-user-orders |
| GET_ORDER_DETAILS | user/get-order-detail |
| DELETE_ORDER_ITEM | user/orders (DELETE) |
| REPEAT_ORDER | user/repeat-order |
| GET_USER_BACKORDERS | user/backorders |
| APPROVE_BACKORDER | user/backorders/:id/approve |
| CANCEL_BACKORDER | user/backorders/:id/cancel |
| GET_USER_RETURNS / GET_RETURN_DETAIL / CREATE_RETURN | user/returns |
| GET_MY_INVOICES | user/invoices |
| GET_MY_INVOICE | user/invoice |

### user/ — account & misc
| Constant | Path |
|---|---|
| GET_PROFILE_INFO | user/get-user-detail |
| CHANGE_PASSWORD | user/change-password |
| SAVE_BILLING_ADDRESS | user/save-billing-address |
| SAVE_SHIPPING_ADDRESS | user/save-shipping-address |
| GET_ADDRESSES | user/get-addresses |
| GET_SHIPPING_INFO | user/shipping-info |
| GET_SHIPPING_OPTIONS | user/shipping-options |
| GET_FAVOURITES / TOGGLE_FAVOURITE | user/favourites, user/favourites/:id/toggle |
| FAVOURITES_ADD_ALL_TO_CART | user/favourites/add-all-to-cart |
| TOGGLE_RESTOCK_NOTIFY / GET_RESTOCK_NOTIFY | user/restock-notify |
| GET_REPLENISHMENT | user/replenishment |
| TOGGLE_HIDE_PRICES | user/toggle-hide-prices |
| ADD_SPARE_PARTS / GET_SPARE_PARTS | user/add-spare-part, user/get-spare-part |
| UPLOAD_SPARE_PART_IMAGE | user/spare-part-image |
| SCAN_TRAY / SCAN_TRAY_SEARCH | user/scan-tray, user/scan-tray/search |

### user/ — agent features
| Constant | Path |
|---|---|
| CREATE_CUSTOMER | user/create-customer |
| GET_CUSTOMER_LIST | /user/customer-list |
| GET_MY_CUSTOMER | user/my-customer/:id |
| UPDATE_MY_CUSTOMER | user/update-customer/:id |

### admin/
| Constant | Path |
|---|---|
| GET_COUNTRIES | admin/country-list |
