# אוטומציית הזמנות TopTik

## מה המערכת עושה

לאחר תשלום מאומת ב-Shopify, המערכת ממתינה למסמך המקורי של Tranzila ושולחת לכתובת התפעול מייל אחד בעברית. המייל כולל את פרטי הלקוח והמסירה, המוצרים, הצבע או הגרסה, המק״ט, המחירים, אמצעי התשלום ופרטי החשבונית. מצורפים דף טיפול A4 והחשבונית המקורית, כאשר היא קיימת.

אירועי ביטול, החזר, תשלום חסר, סיכון חריג או פרטי מסירה חסרים אינם יוצרים הוראת משלוח רגילה. הם מועברים לכתובת ההתראות של הבעלים.

## מיקום השירות

- Webhook של Shopify: `/api/webhooks/shopify/orders`
- עובד תור: `/api/admin/orders/automation`
- דוח חודשי לרואה החשבון: `/api/admin/orders/monthly-report`
- בסיס נתונים: פרויקט Supabase של TopTik, טבלאות שמתחילות ב-`toptik_order_automation_`
- פריסה: פרויקט Vercel של `landing.toptik.co.il`

## סודות והגדרות

כל הסודות נמצאים רק במשתני הסביבה של Vercel. אין לשמור אותם בקוד או במסמך זה.

ההגדרות הנדרשות הן: `SHOPIFY_WEBHOOK_SECRET`, פרטי Admin API הקיימים, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `TRANZILA_API_APP_KEY`, `TRANZILA_API_SECRET`, `TRANZILA_INVOICE_TERMINAL`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER`, `ORDER_OPERATIONS_EMAIL` ו-`ORDER_ALERT_EMAIL`.

`ACCOUNTANT_EMAIL` נשאר ריק עד לקבלת כתובת מאומתת. יש להגדיר גם `ACCOUNTANT_EMAIL_VERIFIED=true` רק לאחר אימות הכתובת.

## בדיקת פעילות

1. ב-Vercel בודקים שהקריאות למסלול עובד התור מחזירות `200`.
2. ב-Supabase בודקים את מצב ההזמנה בטבלת `toptik_order_automation_jobs`.
3. מצב `sent` כולל `sent_at` ו-`gmail_message_id`.
4. מצב `held` או `failed` מחייב בדיקה של `last_error_code`.
5. אין להפעיל את אותה הזמנה ידנית שוב לפני שבודקים את הרשומה הקיימת.

## טיפול בתקלה

- `INVOICE_PENDING`: המערכת ממתינה ל-Tranzila ותנסה שוב אוטומטית.
- `INVOICE_MISSING_AFTER_WAIT`: דף הטיפול נשלח, אך המסמך החשבונאי חסר וטל קיבל התראה.
- `ORDER_PHONE_MISSING` או `ORDER_SHIPPING_ADDRESS_MISSING`: אין לשלוח את המוצר עד להשלמת הפרטים.
- `ORDER_RISK_REVIEW`: אין לשלוח לפני בדיקת ההזמנה ב-Shopify.
- `GMAIL_DELIVERY_UNCERTAIN`: אין לשלוח שוב ידנית לפני בדיקת Gmail, כדי למנוע כפילות.
- כשל חיבור זמני: העובד מנסה שוב. לאחר שמונה ניסיונות ההזמנה עוברת ל-`failed`.

## כללי חשבוניות

PayPal ו-Tranzila PayTech הם אמצעי תשלום. Tranzila Paytech Invoice היא מערכת המסמכים החשבונאיים. המערכת אינה יוצרת בעצמה מסמך בשם חשבונית או קבלה, ואינה מציגה אישור PayPal כחשבונית. מסמך קיים לעולם אינו מופק מחדש.
