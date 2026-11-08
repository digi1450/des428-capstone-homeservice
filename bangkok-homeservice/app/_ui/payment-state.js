// Shared by the payment widget and its tests; server eligibility remains mandatory.
export function paymentStatus(view) {
  const order=view?.order;
  // Booking refund/cancellation is later than an intent's historical success.
  if(order?.payment_status==='refunded') return 'refunded';
  if(order?.status!=='cancelled' && view?.payment_intent?.status==='succeeded') return 'paid';
  return order?.payment_status;
}
export function canSimulatePayment(view) {
  const order=view?.order;
  return !['pending','attention'].includes(order?.cancellation_status) && order?.payment_method==='gateway' && order.status!=='cancelled' && !['paid','refunded'].includes(paymentStatus(view)) &&
    view.payment_intent?.status==='requires_payment' &&
    (view.payment_setup===undefined || view.payment_setup==='ready');
}
