# Rapid Image (RapidOne) feature list

Researched 2026-11-19 from <https://www.rapid-image.com/> (the product,
industry, specification and FAQ pages in Hebrew and English, the training-video
and manuals index, and selected blog posts), the public API spec at
<https://api.rapid-image.net/openapi.json> and the webhook guide at
<https://api.rapid-image.net/webhooks.html>. The site is mostly in Hebrew;
feature names are translations, with Hebrew terms in parentheses where they
help. Marketing claims are recorded as the site states them and are not
verified. About 90 SEO blog posts (titles ending in `-ai`) were not all read;
the ones sampled repeat the product pages.

## Summary: fit with Retainer's extension design

This maps the RapidOne features that still need code to Retainer's extension
design ([extensions spec](../specs/extensions.md),
[standalone apps](../standalone-apps.md)). The table shows the code to build and
any platform work it depends on. Features already supported by Retainer or
covered by schema setup are omitted, including lead and deal records, tasks,
the pipeline board, the document archive and the public API.

### What Routines cover now

As of 2026-11-21, [Routines](../specs/routines.md) are on Retainer's main
branch and available in deployments configured with the routine runner. A
clinic describes what it wants in plain language. The builder checks the
workspace's schema and available tools, reports gaps, and proposes a trigger,
conditions and TypeScript code for an admin to review and approve. An
approved routine can act on a record change, run on a recurring schedule in
the workspace's time zone, or appear as a button on a record. It can read and
write Retainer records, call approved tools from installed extensions, and
use a model through Retainer when configured.

- **Stage checklists and follow-up tasks.** Create a checklist when a deal
  reaches Proposal, scan daily for open leads with no recent contact, or
  create a staff task for overdue work. These are workspace routines once the
  relevant statuses, dates and assignees are in Retainer.
- **Status updates.** A routine can propose Booked when an appointment is
  created. Every routine writes as an agent, so replacing a status set by a
  person or an integration still goes through review.
- **Patient reminders and status-triggered messages.** A routine can select
  appointments on a recurring schedule or respond to a status change, then
  check conditions and call a workspace-connected send tool. A relative
  trigger like “24 hours before this appointment” is still deferred. Recurring
  scans can cover reminder windows, subject to schedule limits. The send tool
  must use the call's idempotency key to prevent duplicate sends on retries.
  Provider code still handles replies and records confirmations.
- **Provider actions and incoming events.** A manual routine can put Send
  Quote or Click to Call on a record once an extension publishes the
  corresponding tool. A routine can create a lead from a missed-call record
  once the phone extension logs that event. Standing routines use workspace
  connections. Tools tied to a staff member's account require a manual run.

Record-triggered routines run after the change has been saved. Conflict-safe
booking, atomic reservations, public requests that need an immediate answer,
and interactive clinical screens still need dedicated code.

### The adjustments

- **Provider tools:** the [extension tool contract](../specs/extensions-tools.md)
  lets installed extensions publish typed actions that routines can call.
  The work is to build or expose the specific action and connect its provider.
- **Request-answering routes:** a hosted function that answers a public request
  directly. Today a route only accepts a webhook, queues a job and answers 202,
  so a public page needs a standalone app: a separate service with its own UI
  that installs through the same grant model.
- **Extension screens:** UI supplied by an extension inside the web app. No
  extension-supplied UI runs in v1.
- **More view kinds:** extensions can contribute only table views. The web app
  has a board view; calendar and chart views don't exist.
- **Notifications:** a per-person inbox and a `notify` call for extensions.
  Nothing stores a notification for a person today.
- **Atomic multi-record writes:** commit several records or none, plus counters
  and holds that expire. One unique field already blocks a duplicate value
  under concurrent writes; nothing spans several records.
- **Narrower grants:** access to chosen objects, fields or branches, for
  extensions and for people. Grants and roles cover the whole workspace.
- **Reporting:** the API and routines can calculate aggregates such as sums
  and averages on supported fields. Reports still need code to shape the
  results and present them in charts or dashboards.
- **Dependent fields:** options or visibility that depend on another field.

### Feature by feature

| Feature                                                  | Code to write                                                    | Fits today                      | Adjustment it might require                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **CRM and sales**                                        |                                                                  |                                 |                                                                                                                   |
| Lead capture from web forms and landing pages            | Webhook extension per form source                                | Yes                             | None                                                                                                              |
| Missed call creates a lead                               | Phone-provider webhook that logs missed calls                    | Yes                             | A routine can create the lead from the recorded call                                                              |
| Sales reports, lead-source return, agent statistics      | Export extension to a BI tool, or in-app reports                 | Export: yes. In-app: no         | In-app reporting needs chart views or dashboard screens                                                           |
| **Scheduling**                                           |                                                                  |                                 |                                                                                                                   |
| Calendar screen by staff and room                        | A calendar view in the web app                                   | No                              | More view kinds (calendar) or extension screens                                                                   |
| Online booking, fixed-length slots                       | Booking app with a public page                                   | Yes, as a standalone app        | Request-answering routes, to host it; narrower grants                                                             |
| Booking engine: several resources, slot holds, waitlist  | Booking app plus reservation logic                               | Partly                          | Atomic multi-record writes; narrower grants                                                                       |
| Shifts, room and bed assignment                          | Assignment logic that prevents conflicts                         | Partly                          | Atomic multi-record writes                                                                                        |
| Reminders and confirmations to patients (SMS, WhatsApp)  | Provider send tool and reply webhook                             | Yes                             | A routine can scan reminder windows. Relative triggers are deferred                                               |
| Google Calendar sync                                     | Sync extension with a connection per member                      | Yes                             | None                                                                                                              |
| **Clinical records**                                     |                                                                  |                                 |                                                                                                                   |
| Dental chart, body and face diagram, treatment room      | Custom screens                                                   | No                              | Extension screens                                                                                                 |
| Digital forms, consents, health declarations             | Forms app with public pages                                      | Yes, as a standalone app        | Request-answering routes, to host it                                                                              |
| Patient self-registration                                | Registration page with a verification code                       | Yes, as a standalone app        | Request-answering routes, to host it                                                                              |
| Digital signature                                        | Signing-provider tool and callback handling                      | Yes                             | The routine can start the signing request                                                                         |
| Digital prescriptions sent to pharmacies                 | Prescription-service tool                                        | Yes                             | Provider access and prescription workflow                                                                         |
| Popup notes on a record                                  | Web app addition on top of comments                              | No                              | Not an extension; a web app change                                                                                |
| **Billing and payments**                                 |                                                                  |                                 |                                                                                                                   |
| Quote PDF, produced and sent                             | PDF renderer and delivery tool                                   | Yes                             | A manual routine can supply the record button                                                                     |
| Invoices, receipts, credit notes                         | Accounting-provider tool                                         | Yes with a provider             | Native numbering still needs atomic multi-record writes                                                           |
| Card payments, payment links, deposits                   | Payment-provider tool and webhook for results                    | Yes with a provider             | Provider idempotency and reconciliation                                                                           |
| Health-fund and insurer billing, doctor pay, commissions | Extension that computes and writes the amounts                   | Yes                             | Reporting, for billing and payroll views                                                                          |
| Coupons and vouchers                                     | Redemption logic                                                 | Partly                          | Atomic multi-record writes, to redeem once                                                                        |
| Inventory with reordering                                | Stock logic plus a scheduled reorder check                       | Partly                          | Atomic multi-record writes, for stock counts                                                                      |
| **Messaging**                                            |                                                                  |                                 |                                                                                                                   |
| Send WhatsApp, SMS or email on a trigger                 | Send tool per messaging provider                                 | Yes                             | A routine handles the trigger and message rules                                                                   |
| Incoming messages saved to the patient file              | Webhook extension per messaging provider                         | Yes                             | None                                                                                                              |
| Shared team inbox, broadcasts                            | Inbox screen, recipient selection and provider send tools        | Partly                          | Extension screens for the shared inbox                                                                            |
| Reminders to staff, alerts center                        | Slack or email send tool, or an in-app notification center       | Slack or email: yes. In-app: no | A routine handles when to alert. In-app delivery needs notifications                                              |
| Patient bot on WhatsApp                                  | An agent connected through the messaging extension               | Yes                             | None                                                                                                              |
| **Operations**                                           |                                                                  |                                 |                                                                                                                   |
| Role permissions, per-branch access                      | Access rules for people and extensions                           | No                              | Narrower grants                                                                                                   |
| Course capacity limits                                   | Registration logic                                               | Partly                          | Atomic multi-record writes                                                                                        |
| In-app dashboards                                        | Dashboard screens or chart views                                 | No                              | Chart views or extension screens                                                                                  |
| Outgoing webhooks                                        | Extension that posts record changes to a URL                     | Yes                             | None                                                                                                              |
| Data migration and lead import                           | Import extension per source system                               | Yes                             | None                                                                                                              |
| Patient portal                                           | Portal app with patient sign-in                                  | Yes, as a standalone app        | Request-answering routes, to host it; narrower grants                                                             |
| Phone system and call center                             | Phone-provider actions, webhooks and call-center UI              | Partly                          | A manual routine can supply Click to Call. Live call handling needs a separate runtime                            |
| Waiting-room queue screens                               | Display screens                                                  | No                              | Extension screens, or a standalone app                                                                            |
| Surveys, video visits, attendance                        | Ingestion extension per provider                                 | Yes                             | None                                                                                                              |

## What it is

Rapid Image is an Israeli company. Its main product, **RapidOne** (רפיד וואן),
is management software that the site calls an ERP for clinics and medical
centers: dental, aesthetics, plastic surgery, sports centers, eye clinics,
physiotherapy, mental health and general clinics. It also sells **RapidVet** for
veterinary clinics, pet hospitals and dog groomers. The site says RapidOne runs
for one user up to hundreds, and for one clinic up to a network of clinics. It is
built on SAP Business One. Older product names still appear in posts and Tax
Authority registrations: **Rapid Med**, **Rapid Pro** and **Rapid Med Pro**.

Other fields the FAQ and blog name: fertility, dermatology, gynecology,
pediatrics, ENT, speech therapy, complementary medicine, psychiatry, hair
removal and hair clinics, pilates and yoga studios.

## Core RapidOne modules

- Telephone switchboard (מרכזייה טלפונית)
- Appointment scheduling (מערכת זימון תורים) and an advanced appointment calendar
- Treatment plans and price quotes (תכנית טיפול והצעות מחיר)
- Treatment plans drawn on a body and face diagram
- CRM for leads and sales (CRM - ניהול לידים ומכירות)
- Document and photo archive (ארכיון מסמכים ותמונות)
- Document management and invoicing (ניהול מסמכים והפקת חשבוניות)
- Digital forms (טפסים דיגיטליים)
- Courses module (מודול קורסים): registrations, capacity limits, transfers between
  courses, reminders, digital classrooms and progress tracking including test
  scores

## Scheduling and calendar

- Online self-booking through the patient portal, matched to staff availability
- Booking several services at once and booking treatment series
- Real-time sync with staff calendars
- Conflict detection, with alternative slots offered
- Room and bed allocation
- Waitlist for a specific date, matched to patient availability, with automatic
  scheduling
- Automatic reminders before each appointment, to cut no-shows
- Appointment statuses: booked, confirmed (two confirmation levels), arrived, in
  treatment, cancelled with a cancellation type and reason
- Slots locked while a patient fills in details, so no double booking
- Appointment types, rooms, equipment and several staff per service line
- Online booking with a cancellation policy and optional prepayment
- Find patients with no future appointment, and appointments by number of
  reminders sent, payment status, sales agent or invoice status

## CRM and sales

- Real-time tracking of each lead: status, tasks and a custom process per lead
- Sales automations: automatic reminders, follow-up on stuck leads, contact rules
- Sales pipeline from lead to closed deal
- Sales activity reports and statistics
- Missed calls create leads in the CRM automatically
- Leads captured straight from web forms and landing pages, with their source
  and campaign, into a holding pool before they become customers
- Duplicate-inquiry detection, blocklists, and recognition of which lead vendor a
  lead came from
- Lead status with sub-status and reason levels (for example "scheduled
  appointment"), configured per clinic
- Lead follow-up rules ("lead tracking" settings), and lead status updated
  automatically after an event linked to the customer
- Tracking from lead to customer, appointment and closed deal, to judge each
  lead vendor's return
- Call-center performance by lead: leads in, handled, not yet handled, split by
  agent
- Checklists per lead or patient
- Deal amount and amount paid on each lead; treatment plans close as deals
- Lead import from campaigns, websites and lists
- Tasks and CRM with SLA targets (Headless page)

## Clinical records

- Secure digital patient file: medical history, test results and notes from each
  visit
- Access to X-rays, diagnoses and past visit notes
- Digital dental chart for planning and tracking treatment
- Digital exam templates (eye clinics)
- Before and after photos (aesthetics)
- Personalized rehab plans and progress tracking (physiotherapy)
- Digital intake forms, treatment consents and surveys
- Dynamic forms with conditional fields; several forms sent in one link; health
  declarations; lab forms
- Diagnoses (permanent or temporary), prescriptions and visit forms as PDF
- Medical follow-up (מעקב רפואי) and medical recalls
- Pathology management, surgery reporting and outside referrals
- Fixed phrases for describing treatments, and custom user fields on treatment
  records
- Point marking, drawing and notes on body and face diagrams, compared across
  treatments
- Treatment room view, intervals between treatments, graphic treatment plans
- Popup notes on the patient card, shown on card entry, invoicing or booking,
  with an expiry date
- Family members with a shared payer file
- Mandatory customer fields, configured per clinic
- Print treatment history; DYMO label printer
- Hair-removal module

## Operations and administration

- Automatic task assignment, with alerts when forms, medical information or
  approvals are missing
- Inventory of equipment, drugs and consumables, with automatic reordering and
  shortage alerts
- Role-based permissions
- Shift management, staff-to-room assignment and patient-to-room or bed
  assignment
- Commission calculations for therapists and sales advisors
- Operational and financial reports
- Automatic messages triggered by report results
- Several branches under one account, with per-branch settings, permissions and
  price lists, and unified or per-branch reports
- Shift wizard in the appointment calendar
- Support tickets (קריאות שירות) with department, assignee, reason, urgency, the
  customer's own words and a staff response
- Alerts center (מרכז ההתרעות) and system-event templates
- Doctor pay (שכר רופא): price lists and pay agreements per doctor
- Configurable dashboard
- Data migration from other clinic software: customers, appointments, documents
  and treatment history
- Microsoft 365 mailbox connection
- Virtual meetings (video visits)
- Vaccination settings and automatic vaccination reminders (RapidVet)

## Billing and payments

- Charges, invoicing and secure payment
- Automatic payment and billing reminders
- Collection reports for health funds and insurers
- Collection receipts and agreements
- Document types: invoice, tax invoice-receipt, receipt, credit note and
  proforma, in Hebrew or English
- Advance payments, and documents hidden until the service is complete
- Payment requests, deposits (הפקדות), refunds and cancellations, a receipt
  cancellation wizard, and converting receipts into tax invoices
- Commitments (התחייבויות) and funding bodies: payment requests to health funds
  and insurers
- Billing agent (סוכן חיובי בילינג)
- Coupons and vouchers, validated through the API
- Bookkeeping report deposits for the accountant
- Outstanding treatment-plan balances
- Israel's 2025/2026 invoice-number rules (חשבוניות ישראל) covered in posts

## Messaging and reminders

- Two-way SMS from the clinic's own number; the patient replies "1" to confirm,
  the confirmation lands in the calendar, other replies go to an "SMS feedback"
  column
- Reminder and arrival-confirmation settings, proactive reminder mailings
- SMS and email message templates
- General reminders as their own task type
- Messages over WhatsApp, SMS and email from one patient file

## Automations and AI

- Automations configured under Admin → CRM → Automations, including outgoing
  webhooks (see "Public API and webhooks")
- Automated messages triggered by a client's status
- AI assistant inside RapidOne (עוזר ה-AI), with a setting to connect the
  clinic's own OpenAI key
- AI chat for patient communication (all-clinics page)
- Headless pitch: build an AI agent that books and cancels appointments, opens
  tasks and writes notes through the API, and charge payments through an
  Easycard MCP server

## Calendar sync

- Google Calendar sync of clinic appointments to staff phones, sold as a
  separate module; can sync to a secondary Google calendar

## Phone system

The same list appears on the CRM, scheduling and calendar pages.

- Cloud switchboard, quick to install, working across several sites and for field
  staff
- Caller ID on every extension; handling and blocking calls by caller ID
- Conference calls for up to five participants
- Tracking of abandoned calls, with reasons why calls went unanswered
- Business hours set per number
- Voicemail with recorded, uploaded or written greetings
- Call routing rules, phone menus (IVR) and 3-digit extensions
- Blocklists for spam and robot numbers, inbound and outbound
- Human check against robot dialers
- Virtual call center
- Automatic callback dialer
- SIP and IP phones, including WiFi phones from several makers
- Cloud backup of settings, recordings and voicemail
- Routing by caller ID, with an ODBC connection option
- Large phone menus of 100 to 1,000 voice channels, with a backup carrier on
  failure
- Setup needs a site survey by a sales rep and the current carrier's invoice to
  move numbers; phones must be configured for the system

## Call center

- Configuration changes in real time
- Call queues and hold music, including music by time of day or holiday
- Ring groups, skill-based routing and time-based routing
- Callback option, parallel calls and unlimited concurrent calls on one number
- Call recording for verification, quality control and training
- Dashboard: wait time, unanswered rate, call volume and a live team view
- Listening in on calls and coaching agents while they talk
- Call logs with Excel export
- Real-time alert to the administrator on abandoned calls

## Add-on products

### Patient portal (פורטל לקוח)

- Self-service booking, including treatment series
- Fill in and sign forms digitally
- Prepay by card, or leave a card deposit as a guarantee
- Upload files and view invoices; invoices are issued automatically

### WhatsApp

- Official verified WhatsApp Business account connected to RapidOne
- 24/7 bot, including a chatbot that collects leads
- Team departments
- Chats saved to the patient file automatically
- Sends booking details, reminders, forms, signed digital invoices and broadcasts

### Easycard payments

- One-time or recurring card charges inside RapidOne
- Standing orders and bank transfers
- Payment links, split payments and deposits
- Automatic invoices
- Claims PCI-DSS compliance

### ANS queue screens (ממשק ANS)

- Waiting-room queue screens and call-direction displays
- Online booking and cancellation, alternative slots and waitlists
- Arrival confirmation and reminders
- Real-time dashboards for waiting times, cancellations, occupancy and arrival
  rates

### Shidurit (שידורית)

- Outsourced human answering service that follows the clinic's scripts
- Logs each call in the patient file and can route urgent calls
- Syncs health-fund calendars and offers online booking

### BI (בינה עסקית)

- Built on Power BI; costs extra
- Dashboards for leads, revenue, marketing, staff output and finance
- Claims trend detection and forecasts

### HOWAZIT

- Patient-experience measurement and surveys
- Messages over WhatsApp, SMS and email
- Real-time alerts on negative feedback

### Digital signature (חתימה דיגיטלית)

- Client signs a quote and enters card details in one flow, with a partner called
  FillFaster
- Signed copy filed in RapidOne automatically
- Priced as a one-time setup fee plus a charge per signed document (no amounts
  given)

### Digital prescriptions (רפואה פרטית - מרשמים דיגיטליים)

- For private doctors; sent automatically to most pharmacies in Israel
- Built with the national drug-registration and supervision unit (ירפ״א)
- Patients show ID at the pharmacy

### RapidOne mobile app

- iPhone and Android
- View the calendar and book appointments
- Manage leads, update patient files and treatments, add photos
- Manage staff in real time

### EZtime

- Staff attendance, hours, shifts, absences and staff documents
- Clock in from the app, the cloud or a dedicated time clock

### RapidOne Headless

- Full API for RapidOne: calendar, patients, treatments, documents and payments
- OpenAPI spec aimed at AI coding tools
- Demo clinic and token within 48 hours; first setup free
- Says it runs on SAP Business One in Israeli data centers
- 48 documented endpoints and 13 outgoing webhook events on one token
- Pitched at solo builders, agencies that build for clinics, health-tech
  startups and clinics wanting their own interface; one product can be sold to
  many clinics, each with its own subscription
- Example builds: online booking app, patient portal with payment, AI agent for
  the clinic, landing pages that feed leads, automations, custom dashboard
- Early-access program: free first clinic setup, technical onboarding, input on
  the roadmap

## Public API and webhooks

The API docs are public at <https://api.rapid-image.net> (OpenAPI 3, "RapidOne
Public API" 1.0.0). Each clinic has its own server at
`https://{customerPrefix}.rapid-image.net`.

- **Auth:** tokens from the admin panel, in three header formats: a lead-source
  token for leads, an external-client token for customers, financial and
  coupons, and another external-client format for upload, portal and PDF calls.
  Server-to-server only; no CORS.
- **Rate limit:** 100 requests per minute per IP, across all endpoints.
- **48 endpoints** in these groups:
  - Leads: create and update by your external ID
  - Customers and patients: create or update, search, fixed directories,
    items and services
  - Patient documents: list by card code or national ID, upload a file or a
    URL, pre-signed download links
  - Clinical: treatments (list, create, update), diagnoses, prescriptions,
    visit forms as PDF
  - Tasks and notes: create and list tasks, read and write patient notes
  - Appointments: per patient, and a filtered feed with no paging
  - Financial documents: create, list, download as PDF
  - Customer portal booking flow: departments and branches, items, the
    patient's default price list, staff roles and users, free-slot search,
    block and release a slot, create and cancel an appointment, appointment
    types, active treatment plans
  - Patient registration: settings, reference lists, send a verification code,
    create a patient
  - Coupons: validate
  - Tickets: create and list
- **Task types:** general reminders, admin tasks, medical recalls, sales tasks,
  lead reminders and appointment reminders. Status: open, in process, closed.
  Urgency: low, normal, high. Assigned to a user, or for medical recalls to a
  schedule group.
- **Lead fields:** name, email or phone (one required), national ID, gender,
  address, interest, wanted treatment, campaign, source, branch, IP address,
  external ID.
- **Customer webhooks** (13 events, set under Admin → CRM → Automations, with an
  optional authentication header): new appointment, appointment updated,
  appointment cancelled, marked arrived, marked in treatment, treatment added,
  new financial document, customer status changed, form assigned, form filled,
  treatment plan added, treatment plan deal closed, checklist item completed.
  Every payload carries the full patient record, including insurance, health
  fund, status and clinic-defined custom fields.
- **Lead webhooks** (2 events, set in lead management settings, no auth header):
  lead created and lead status updated. The payload has status, sub-status,
  reason, assigned agent, campaign, source, appointment details, and whether a
  deal closed with its amount and amount paid.
- The docs ask receivers to be idempotent, since an event can arrive more than
  once.

## Industry pages

- **Aesthetics:** treatment diagrams, treatment history, before and after photos,
  automations to bring patients back, checklists
- **Plastic surgery:** visit documentation, staff tasks, digital prescriptions,
  recovery reminders, follow-up scheduling
- **Sports centers:** member fitness tracking, course and event registration,
  subscription and membership usage, coach calendars
- **Eye clinics:** digital exam templates, diagnosis and prescription records,
  task management
- **Physiotherapy:** rehab plans, progress tracking, alerts when a patient doesn't
  rebook a series, commission calculations
- **Mental health:** signed digital forms, shared staff calendars, reminders,
  progress tracking
- **All clinics:** staff task control, operating and finance reports, automatic
  messages from reports, and an AI chat for patients (mentioned only here)

## RapidVet

- Runs on Google Cloud Platform
- Pricing across several clinics
- Detailed permissions with a change history
- Vaccination records with automatic reminders
- Reports for local authorities
- Lab result imports from IDEXX
- Barcode sales, insurance claims and Google Calendar sync
- Pet hospitals: departments, shift scheduling for urgent cases, X-rays and lab
  results in the medical file, supplier orders
- Dog groomers: grooming history and customer preferences per pet, product
  sales, promotions

## Pricing

The site shows no prices, tiers or free trial. Its calls to action are "book a
demo", which opens WhatsApp, and "contact us". The only pricing details are:

- BI costs extra.
- Digital signature has a setup fee plus a charge per signed document.
- Headless says its first setup is free.

- Google Calendar sync is a separately bought module.
- Headless clinics each pay their own subscription.

It is unclear which other modules are in the base license. Rapid's own pricing
guide (September 2026) gives market ranges, not its own prices: 200–600 ₪ a
month for one doctor and up to 3 users; 600–1,500 ₪ for 2–4 doctors and 4–8
users; 1,500 ₪ and up for 5 or more doctors or several locations. It says price
depends on users, active modules and storage, and that leads, forms, BI, the
portal and payments are usually priced separately.

## Open questions

- **Cloud or on-premise:** the English product page says both are offered.
  Most pages and the FAQ describe cloud hosting with automatic backups; the FAQ
  says Google Cloud, the Headless page says Israeli data centers.
- **ISO 27001:** the page explains the standard but doesn't clearly say Rapid is
  certified; the certificate appears only as an image.
- **Rapid Med, Rapid Pro and Rapid Med Pro:** older product names in posts and
  Tax Authority registrations; how they relate to RapidOne isn't stated.
- **Not read:** most of the manuals' PDFs and videos (only their titles were
  used), the Confluence docs linked from the API page, and most SEO blog posts.
- **Customers named on the site:** Assuta, Noam Chai, Sportana, Barzilai, a
  psychological service center, a veterinary hospital, Olam HaMayim and Ein Tal.
