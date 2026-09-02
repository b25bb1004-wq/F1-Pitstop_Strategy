import pandas as pd
import fastf1
import glob
import os
import random

random.seed(42) #so the split is reproducible across runs
fastf1.Cache.enable_cache('../cache')

files = glob.glob('../data/*.csv')
dfs = []
for f in files:
    circuit_name = os.path.basename(f).replace('.csv', '')
    if circuit_name in ('train', 'dev', 'test'):
        continue
    df = pd.read_csv(f, low_memory=False)
    df['location'] = circuit_name
    dfs.append(df)

all_data = pd.concat(dfs, ignore_index=True)
all_data['location'] = all_data['location'].replace({
    'Monte Carlo' : 'Monaco',
    'Miami Gardens' : 'Miami'
})

#the round_number bug: different script versions across this project's history wrote
#different column sets to the same per-circuit CSVs, and one of those mismatches
#shifted `location` into `round_number` on every append after it (or left it blank).
#By the time this was caught, that had corrupted round_number in 82% of train rows,
#89% of dev, 66% of test - it was never actually repaired, only stopped from getting
#worse (append_matching_schema in data_pull.py prevents new corruption, but every
#already-collected row stayed broken). round_number isn't used as a model feature
#today, so this hasn't tainted any existing result - but it's real damage sitting in
#the data, and anything that needs a genuine session identifier (pulling weather from
#the FastF1 cache, for one) needs it fixed. Re-derived here from FastF1's own event
#schedule instead of trusted from the file, since `location` + `year` + `LapStartDate`
#are all clean and the schedule is the actual source of truth for which round a race
#was. EventDate is needed, not just (year, location), because two circuits (Austria/
#Spielberg in 2021) hosted two separate rounds the same year - matching each lap to
#the schedule row with the closest EventDate resolves that correctly.
schedule_frames = []
for year in all_data['year'].unique():
    sched = fastf1.get_event_schedule(int(year))
    sched = sched[sched['RoundNumber'] > 0][['RoundNumber', 'Location', 'EventDate']].copy()
    sched['year'] = year
    schedule_frames.append(sched)
schedule = pd.concat(schedule_frames, ignore_index=True)

#Location naming isn't even consistent across the schedule itself (the same circuit
#is "Monaco" some years and "Monte Carlo" others, "Miami"/"Miami Gardens" likewise) -
#map every name in an equivalence class to one canonical key before joining, rather
#than a fixed one-directional alias, since a fixed alias would mismatch whichever
#year uses the opposite spelling.
LOCATION_EQUIVALENCE = [{'Monaco', 'Monte Carlo'}, {'Miami', 'Miami Gardens'}]
def location_key(name):
    for group in LOCATION_EQUIVALENCE:
        if name in group:
            return sorted(group)[0]
    return name

schedule['loc_key'] = schedule['Location'].apply(location_key)
all_data['loc_key'] = all_data['location'].apply(location_key)
all_data['_row_id'] = range(len(all_data))
all_data['_lap_date'] = pd.to_datetime(all_data['LapStartDate'])

matched = all_data.merge(schedule[['year', 'loc_key', 'RoundNumber', 'EventDate']],
                          on=['year', 'loc_key'], how='left')
matched['_date_diff'] = (matched['_lap_date'] - matched['EventDate']).abs()
matched = matched.sort_values('_date_diff').drop_duplicates('_row_id', keep='first')
matched = matched.sort_values('_row_id').reset_index(drop=True)

assert len(matched) == len(all_data), "round_number repair changed row count"
assert matched['RoundNumber'].notna().all(), "round_number repair left unmatched rows"

all_data['round_number'] = matched['RoundNumber'].astype(int).values
all_data = all_data.drop(columns=['loc_key', '_row_id', '_lap_date'])
print(f"repaired round_number for all {len(all_data)} rows via the FastF1 schedule")

#data_pull.py appended the same race again on every re-run after a rate-limit stop,
#so raw files hold each lap several times - keep one copy of each lap.
#Time is the session timestamp, so it also separates double-headers (same year + location).
before = len(all_data)
all_data = all_data.drop_duplicates(subset=['Time', 'Driver', 'LapNumber', 'year', 'location'])
print(f"dropped {before - len(all_data)} duplicate laps, {len(all_data)} remain")

train_frames = []
dev_frames = []
test_frames = []

for location, group in all_data.groupby('location'):
    years = group['year'].unique().tolist()
    random.shuffle(years)
    n = len(years)
    if n >= 5:
        train_end = int(len(years) * 0.60)
        dev_end = train_end + int(len(years) * 0.20)

        train_years = years[ : train_end]
        dev_years = years[train_end : dev_end]
        test_years = years[dev_end : ]

    elif n >= 3:
        train_years = years[:n-2]
        dev_years = [years[-2]]
        test_years = [years[-1]]
    
    else:
        train_years = years
        dev_years = []
        test_years = []
        

    train_frames.append(group[group['year'].isin(train_years)])
    dev_frames.append(group[group['year'].isin(dev_years)])
    test_frames.append(group[group['year'].isin(test_years)])

train_df = pd.concat(train_frames, ignore_index = True)
dev_df = pd.concat(dev_frames, ignore_index = True)
test_df = pd.concat(test_frames, ignore_index = True)

train_df.to_csv('../data/train.csv', index=False)
dev_df.to_csv('../data/dev.csv', index=False)
test_df.to_csv('../data/test.csv', index=False)


print(train_df.shape, dev_df.shape, test_df.shape)
print(train_df['location'].unique())
print(dev_df['location'].unique())
print(test_df['location'].unique())
