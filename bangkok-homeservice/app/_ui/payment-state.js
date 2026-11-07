// Shared by the payment widget and its tests; server eligibility remains mandatory.
export function canSimulatePayment(view) {
  const order=view?.order;
  return order?.payment_method==='gateway' && order.status!=='cancelled' && order.payment_status!=='paid' &&
    view.payment_intent?.status==='requires_payment' &&
    (view.payment_setup===undefined || view.payment_setup==='ready');
}
