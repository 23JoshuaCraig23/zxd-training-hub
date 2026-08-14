# Google Cloud Build deployment

The repository is designed to build, test, and deploy inside the `iliqchuan-nyc` Google Cloud project. A Mac only needs Git access; Node, npm, pnpm, Firebase CLI, and Java are not required for the cloud workflow.

## Pipeline

`cloudbuild.yaml` runs two isolated cloud steps:

1. Use Node.js 22, install the locked dependencies, run Angular tests, and build Angular plus Firebase Functions.
2. Use Firebase CLI with Google Application Default Credentials to deploy Firestore rules/indexes, Functions, and Hosting.

No PayPal or Zoom value is injected into the build. Deployed Functions reference the existing Google Secret Manager entries at runtime.

## One-time Google Cloud setup

1. Select `iliqchuan-nyc` in Google Cloud Console.
2. Enable the Cloud Build, Firebase Management, Firebase Extensions, Cloud Billing, Cloud Functions, Cloud Run, Artifact Registry, Secret Manager, and Cloud Resource Manager APIs.
3. Create a dedicated service account named `firebase-cloud-build`.
4. Grant it the project roles needed to deploy this stack:
   - Cloud Build Service Account
   - Logs Writer
   - Firebase Hosting Admin
   - Firebase Viewer
   - API Keys Viewer
   - Service Usage Consumer
   - Cloud Functions Admin
   - Artifact Registry Writer
   - Secret Manager Viewer
   - Cloud Datastore Index Admin
   - Firebase Rules Admin
5. Grant **Service Account User** only on the default Compute and App Engine service accounts to `firebase-cloud-build`. The Firebase CLI validates both identities while deploying second-generation Functions.
6. Grant **Secret Manager Secret Accessor** on the six integration secrets only to the default Compute service account used by the deployed Functions. The build account can inspect secret metadata but cannot read secret values.
7. Set a cleanup policy on the `gcf-artifacts` repository in `us-central1`. This project retains function container images for 7 days.
8. In **Cloud Build → Repositories**, connect the GitHub repository using the Cloud Build GitHub App.
9. In **Cloud Build → Triggers**, create a push-to-branch trigger:
   - Branch: `^main$`
   - Configuration: Cloud Build configuration file
   - Location: `/cloudbuild.yaml`
   - Service account: `firebase-cloud-build@iliqchuan-nyc.iam.gserviceaccount.com`

The trigger will run on every push to `main`. Use a separate test-only trigger before enabling deployments from pull requests.

## First build

After connecting the repository, choose **Run** on the trigger. Cloud Build is the authoritative build log. A successful run prints the Firebase Hosting URL and the HTTPS URL for `handlePayPalWebhook`.

## Security notes

- The pipeline uses Application Default Credentials provided to its dedicated service account; it does not use a long-lived Firebase token.
- Google Secret Manager values never enter source control or Cloud Build substitutions.
- The deployment service account should not be used by the running application.
- After the first successful deployment, reduce broad setup roles if a review of Cloud Audit Logs shows they are unnecessary.
