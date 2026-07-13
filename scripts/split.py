import pandas as pd
import glob
import os
import random
files = glob.glob('../data/*.csv')
dfs = []
for f in files:
    df = pd.read_csv(f)
    circuit_name = os.path.basename(f).replace('.csv', '')
    df['location'] = circuit_name
    dfs.append(df)

all_data = pd.concat(dfs, ignore_index=True)
all_data['location'] = all_data['location'].replace({
    'Monte Carlo' : 'Monaco',
    'Miami Gardens' : 'Miami'
})

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


print(train_df.shape, dev_df.shape, test_df.shape)
print(train_df['location'].unique())
print(dev_df['location'].unique())
print(test_df['location'].unique())
