export function FinancialStatus({order}) {
 const cancellation=order.cancellation_status,accounting=order.accounting_status;
 if(cancellation==='pending'||cancellation==='attention')return <div className="notice" role="status">{cancellation==='pending'?'Cancellation is being verified. Your slot remains reserved.':'Cancellation needs review. Your slot remains reserved.'}</div>;
 if(accounting==='pending'||accounting==='attention')return <div className="notice" role="status">{accounting==='pending'?'Booking completed. The wallet update is still being processed.':'Booking completed. The financial update needs review.'}</div>;
 return null;
}
