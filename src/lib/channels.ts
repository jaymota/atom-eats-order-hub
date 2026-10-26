// The six channels Atom Eats sells offline through. Every order has one.
export const CHANNELS = ['Modern Retail', 'General Trade', 'Quick Commerce', 'B2B', 'Gifting', 'FOC'] as const

export const CHANNEL_HINT: Record<string, string> = {
  'Modern Retail': 'Food Square, Foodstories, other chains',
  'General Trade': 'Stores from field sales (Vinay)',
  'Quick Commerce': 'Blinkit, Swiggy Instamart',
  B2B: 'Bulk orders, other WhatsApp orders',
  Gifting: 'Gift boxes and hampers',
  FOC: 'Free samples (value ₹0)',
}
