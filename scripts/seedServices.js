import mongoose from 'mongoose';
import { getEnv } from '../src/config/env.js';
import { seedServices, listServices } from '../src/services/catalog/catalog.service.js';
import '../src/models/index.js';

await mongoose.connect(getEnv().mongoUri, { serverSelectionTimeoutMS: 10000 });
await Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));
await seedServices();
const all = await listServices({ activeOnly: false });
console.log(`Seeded/verified ${all.length} services:`);
for (const s of all) console.log(` - ${s.id} [${s.category}] live=${s.live} pricingApproved=${Boolean(s.pricing?.approved)}`);
await mongoose.disconnect();
